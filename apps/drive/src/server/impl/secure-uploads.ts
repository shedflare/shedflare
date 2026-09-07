import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { files, secureUploadSessions, secureUploadStartCapabilities } from "../../db/schema";
import { driveApi } from "../definitions";
import { commandExpiry } from "../command-expiry";
import {
  SECURE_UPLOAD_MAX_BYTES,
  SECURE_UPLOAD_PART_SIZE,
  secureUploadMetadataDigest,
  signSecureUploadCapability,
  verifySecureUploadCapability,
  type SecureUploadSessionCapability,
} from "../secure-upload-capability";
import type { HttpApiAuth } from "@shedflare/auth-client/http-api";
import { array, looseObject, number, safeParse, string } from "valibot";

const SESSION_EXPIRY_MS = 6 * 60 * 60 * 1_000;

type SecureUploadEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  SECURE_UPLOAD_TOKEN_SECRET: string;
};

type UploadMetadata = {
  name: string;
  mimeType: string;
  size: number;
};

function json<Body>(body: Body, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function error(status: number, code: string, message: string) {
  return json({ code, error: message, retryable: status >= 500 }, { status });
}

function hasForbiddenFilenameCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "/" || character === "\\" || codePoint <= 31 || codePoint === 127;
  });
}

const MetadataSchema = looseObject({ name: string(), mimeType: string(), size: number() });
const PartSchema = looseObject({ partNumber: number(), etag: string() });
const CompleteBodySchema = looseObject({
  name: string(),
  mimeType: string(),
  size: number(),
  parts: array(PartSchema),
});

function parseMetadata<Value>(value: Value): UploadMetadata | null {
  const parsed = safeParse(MetadataSchema, value);
  if (!parsed.success) return null;
  const name = parsed.output.name.trim();
  const mimeType = parsed.output.mimeType.trim();
  const size = parsed.output.size;
  if (
    !name ||
    name.length > 512 ||
    hasForbiddenFilenameCharacter(name) ||
    !mimeType ||
    mimeType.length > 255 ||
    /[\r\n]/u.test(mimeType) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > SECURE_UPLOAD_MAX_BYTES
  ) {
    return null;
  }
  return { name, mimeType, size };
}

function parseParts<Value>(value: Value, expectedCount: number): R2UploadedPart[] | null {
  const parsed = safeParse(array(PartSchema), value);
  if (!parsed.success || parsed.output.length !== expectedCount) return null;
  const parts: R2UploadedPart[] = [];
  for (const [index, part] of parsed.output.entries()) {
    if (part.partNumber !== index + 1 || !part.etag || part.etag.length > 256) {
      return null;
    }
    parts.push({ partNumber: part.partNumber, etag: part.etag });
  }
  return parts;
}

function bashUploader(origin: string, startToken: string) {
  const apiRoot = `${origin}/api/secure-uploads`;
  return `#!/usr/bin/env bash
set -euo pipefail

api_root=${JSON.stringify(apiRoot)}
start_token=${JSON.stringify(startToken)}
max_bytes=${SECURE_UPLOAD_MAX_BYTES}
session_token=""
completed=0

abort_incomplete_upload() {
  status=$?
  if [[ $completed -eq 0 && -n $session_token ]]; then
    curl -fsS -X DELETE "$api_root/session/$session_token" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap abort_incomplete_upload EXIT

if [[ $# -ne 1 || $1 == "<path-to-file>" ]]; then
  echo 'Replace <path-to-file> with the file you want to upload.' >&2
  exit 2
fi

path=$1
if [[ ! -f $path ]]; then
  echo "File not found: $path" >&2
  exit 2
fi

size=$(wc -c < "$path" | tr -d '[:space:]')
if [[ ! $size =~ ^[0-9]+$ ]]; then
  echo "Could not determine file size: $path" >&2
  exit 2
fi
if (( size > max_bytes )); then
  echo "File is too large: $size bytes (maximum $max_bytes bytes / 500 MB)." >&2
  exit 2
fi

name=\${path##*/}
mime_type=application/octet-stream
if command -v file >/dev/null 2>&1; then
  detected_mime=$(file -b --mime-type -- "$path" 2>/dev/null || true)
  if [[ -n $detected_mime ]]; then
    mime_type=$detected_mime
  fi
fi

start_response=$(curl -fsS -X POST \
  -H 'Accept: text/plain' \
  --data-urlencode "name=$name" \
  --data-urlencode "mimeType=$mime_type" \
  --data-urlencode "size=$size" \
  "$api_root/start/$start_token")
IFS=$'\\t' read -r session_token part_size <<< "$start_response"
if [[ -z $session_token || ! $part_size =~ ^[0-9]+$ ]]; then
  echo 'Drive returned an invalid upload session.' >&2
  exit 1
fi

total_parts=$(( (size + part_size - 1) / part_size ))
if (( total_parts == 0 )); then
  total_parts=1
fi
complete_args=(
  --data-urlencode "name=$name"
  --data-urlencode "mimeType=$mime_type"
  --data-urlencode "size=$size"
)

for (( part_number=1; part_number<=total_parts; part_number++ )); do
  offset=$(( (part_number - 1) * part_size ))
  remaining=$(( size - offset ))
  chunk_size=$part_size
  if (( remaining < part_size )); then
    chunk_size=$remaining
  fi

  etag=$(dd if="$path" bs="$part_size" skip=$(( part_number - 1 )) count=1 2>/dev/null | \
    curl -fsS -X PUT \
      -H 'Accept: text/plain' \
      -H 'Content-Type: application/octet-stream' \
      -H "Content-Length: $chunk_size" \
      --data-binary @- \
      "$api_root/session/$session_token/parts/$part_number")
  if [[ -z $etag ]]; then
    echo "Drive returned an invalid result for part $part_number." >&2
    exit 1
  fi
  complete_args+=(
    --data-urlencode "partNumber=$part_number"
    --data-urlencode "etag=$etag"
  )
  uploaded=$(( part_number * part_size ))
  if (( uploaded > size )); then
    uploaded=$size
  fi
  echo "Uploaded $uploaded / $size bytes ($part_number/$total_parts parts)" >&2
done

curl -fsS -X POST \
  -H 'Accept: text/plain' \
  "\${complete_args[@]}" \
  "$api_root/session/$session_token/complete" >/dev/null
completed=1
echo "Uploaded $name to Shedflare Drive."
`;
}

function acceptsPlainText(request: Request) {
  return request.headers
    .get("accept")
    ?.split(",")
    .some((value) => value.trim() === "text/plain");
}

function plainText(body: string, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}

async function validStartCapability(env: SecureUploadEnv, token: string) {
  const capability = await verifySecureUploadCapability(env, token);
  if (capability?.kind !== "secure-upload-start" || capability.expiresAt < Date.now()) return null;
  const registered = await drizzle(env.DB)
    .select({ nonce: secureUploadStartCapabilities.nonce })
    .from(secureUploadStartCapabilities)
    .where(
      and(
        eq(secureUploadStartCapabilities.nonce, capability.nonce),
        isNull(secureUploadStartCapabilities.consumedAt),
        gte(secureUploadStartCapabilities.expiresAt, Date.now()),
      ),
    )
    .get();
  return registered ? capability : null;
}

async function registeredStartCapability(env: SecureUploadEnv, token: string) {
  const capability = await verifySecureUploadCapability(env, token);
  if (capability?.kind !== "secure-upload-start" || capability.expiresAt < Date.now()) return null;
  const registered = await drizzle(env.DB)
    .select({ nonce: secureUploadStartCapabilities.nonce })
    .from(secureUploadStartCapabilities)
    .where(
      and(
        eq(secureUploadStartCapabilities.nonce, capability.nonce),
        gte(secureUploadStartCapabilities.expiresAt, Date.now()),
      ),
    )
    .get();
  return registered ? capability : null;
}

async function validSessionCapability(env: SecureUploadEnv, token: string) {
  const capability = await verifySecureUploadCapability(env, token);
  return capability?.kind === "secure-upload-session" && capability.expiresAt >= Date.now()
    ? capability
    : null;
}

async function verifiedSessionCapability(env: SecureUploadEnv, token: string) {
  const capability = await verifySecureUploadCapability(env, token);
  return capability?.kind === "secure-upload-session" ? capability : null;
}

async function consumeStartCapability(env: SecureUploadEnv, nonce: string) {
  return await drizzle(env.DB)
    .update(secureUploadStartCapabilities)
    .set({ consumedAt: Date.now() })
    .where(
      and(
        eq(secureUploadStartCapabilities.nonce, nonce),
        isNull(secureUploadStartCapabilities.consumedAt),
        gte(secureUploadStartCapabilities.expiresAt, Date.now()),
      ),
    )
    .returning({ nonce: secureUploadStartCapabilities.nonce })
    .get();
}

export async function cleanupExpiredSecureUploads(env: SecureUploadEnv): Promise<number> {
  const database = drizzle(env.DB);
  const expired = await database
    .select()
    .from(secureUploadSessions)
    .where(lte(secureUploadSessions.expiresAt, Date.now()))
    .limit(25);
  let cleaned = 0;
  for (const session of expired) {
    try {
      await env.FILES.resumeMultipartUpload(`files/${session.fileId}`, session.uploadId).abort();
      await database
        .delete(secureUploadSessions)
        .where(eq(secureUploadSessions.uploadId, session.uploadId));
      cleaned += 1;
    } catch {
      // R2 automatically expires incomplete multipart uploads after seven days.
      // Keep transient failures registered so a later authenticated command retries cleanup.
    }
  }
  return cleaned;
}

async function startUpload(env: SecureUploadEnv, request: Request, token: string) {
  const startCapability = await registeredStartCapability(env, token);
  if (!startCapability)
    return error(401, "invalid_or_expired_token", "Upload token is invalid or expired.");

  const form = await request.formData().catch(() => null);
  const rawSize = form ? Number(form.get("size")) : Number.NaN;
  if (Number.isSafeInteger(rawSize) && rawSize > SECURE_UPLOAD_MAX_BYTES) {
    return error(413, "upload_too_large", "Secure uploads are limited to 500 MB.");
  }
  const metadata = parseMetadata(
    form
      ? {
          name: form.get("name"),
          mimeType: form.get("mimeType"),
          size: rawSize,
        }
      : null,
  );
  if (!metadata) {
    return error(
      400,
      "invalid_upload_metadata",
      "Provide a valid filename, content type, and size no larger than 500 MB.",
    );
  }

  if (!(await consumeStartCapability(env, startCapability.nonce))) {
    return error(409, "upload_token_already_used", "Upload token has already been used.");
  }

  const fileId = crypto.randomUUID();
  let upload: R2MultipartUpload | undefined;
  try {
    upload = await env.FILES.createMultipartUpload(`files/${fileId}`, {
      httpMetadata: { contentType: metadata.mimeType },
    });
    const sessionCapability: SecureUploadSessionCapability = {
      kind: "secure-upload-session",
      expiresAt: Date.now() + SESSION_EXPIRY_MS,
      fileId,
      uploadId: upload.uploadId,
      size: metadata.size,
      metadataDigest: await secureUploadMetadataDigest(metadata),
    };
    await drizzle(env.DB).insert(secureUploadSessions).values({
      uploadId: upload.uploadId,
      fileId,
      expiresAt: sessionCapability.expiresAt,
      createdAt: Date.now(),
    });
    const sessionToken = await signSecureUploadCapability(env, sessionCapability);
    if (acceptsPlainText(request)) {
      return plainText(`${sessionToken}\t${SECURE_UPLOAD_PART_SIZE}\n`, { status: 201 });
    }
    return json(
      { fileId, uploadId: upload.uploadId, partSize: SECURE_UPLOAD_PART_SIZE, sessionToken },
      { status: 201 },
    );
  } catch {
    if (upload) await upload.abort().catch(() => undefined);
    return error(503, "multipart_create_failed", "Drive could not start the upload. Retry.");
  }
}

async function uploadPart(
  env: SecureUploadEnv,
  request: Request,
  capability: SecureUploadSessionCapability,
  partNumber: number,
) {
  const totalParts = Math.max(1, Math.ceil(capability.size / SECURE_UPLOAD_PART_SIZE));
  const expectedSize =
    partNumber < totalParts
      ? SECURE_UPLOAD_PART_SIZE
      : capability.size - (totalParts - 1) * SECURE_UPLOAD_PART_SIZE;
  const contentLength = Number(request.headers.get("content-length"));
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > totalParts ||
    !Number.isSafeInteger(contentLength) ||
    contentLength !== expectedSize
  ) {
    return error(400, "invalid_upload_part", "Upload part number or size is invalid.");
  }

  try {
    const upload = env.FILES.resumeMultipartUpload(
      `files/${capability.fileId}`,
      capability.uploadId,
    );
    const part = await upload.uploadPart(partNumber, request.body ?? new Uint8Array());
    return acceptsPlainText(request) ? plainText(`${part.etag}\n`) : json(part);
  } catch {
    return error(503, "upload_part_failed", `Drive could not store part ${partNumber}. Retry it.`);
  }
}

async function storedFileResponse(env: SecureUploadEnv, fileId: string) {
  const row = await drizzle(env.DB).select().from(files).where(eq(files.id, fileId)).get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    description: row.description ?? "",
    isPublic: Boolean(row.isPublic),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tags: [],
  };
}

async function completeUpload(
  env: SecureUploadEnv,
  request: Request,
  capability: SecureUploadSessionCapability,
) {
  const existing = await storedFileResponse(env, capability.fileId);
  if (existing) return acceptsPlainText(request) ? plainText("ok\n") : json({ file: existing });

  const expectedParts = Math.max(1, Math.ceil(capability.size / SECURE_UPLOAD_PART_SIZE));
  const contentType = request.headers.get("content-type") ?? "";
  let metadata: UploadMetadata | null = null;
  let parts: R2UploadedPart[] | null = null;
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = await request.formData().catch(() => null);
    if (form) {
      metadata = parseMetadata({
        name: form.get("name"),
        mimeType: form.get("mimeType"),
        size: Number(form.get("size")),
      });
      const partNumbers = form.getAll("partNumber");
      const etags = form.getAll("etag");
      parts = parseParts(
        partNumbers.map((partNumber, index) => ({
          partNumber: Number(partNumber),
          etag: etags[index],
        })),
        expectedParts,
      );
    }
  } else {
    const body = await request.json().catch(() => null);
    metadata = parseMetadata(body);
    const completeBody = safeParse(CompleteBodySchema, body);
    parts = completeBody.success ? parseParts(completeBody.output.parts, expectedParts) : null;
  }
  if (
    !metadata ||
    metadata.size !== capability.size ||
    (await secureUploadMetadataDigest(metadata)) !== capability.metadataDigest ||
    !parts
  ) {
    return error(400, "invalid_upload_completion", "Upload metadata or parts are invalid.");
  }

  const objectKey = `files/${capability.fileId}`;
  try {
    const existingObject = await env.FILES.get(objectKey);
    const object = existingObject
      ? existingObject
      : await env.FILES.resumeMultipartUpload(objectKey, capability.uploadId).complete(parts);
    if (object.size !== metadata.size) {
      await Promise.all([
        env.FILES.delete(objectKey),
        drizzle(env.DB)
          .delete(secureUploadSessions)
          .where(eq(secureUploadSessions.uploadId, capability.uploadId)),
      ]);
      return error(400, "upload_size_mismatch", "The uploaded file size did not match.");
    }
  } catch {
    return error(503, "multipart_complete_failed", "Drive could not finish the upload. Retry.");
  }

  const now = new Date().toISOString();
  try {
    await drizzle(env.DB).insert(files).values({
      id: capability.fileId,
      objectKey,
      name: metadata.name,
      mimeType: metadata.mimeType,
      size: metadata.size,
      description: "",
      isPublic: false,
      createdAt: now,
      updatedAt: now,
    });
    const file = await storedFileResponse(env, capability.fileId);
    if (!file) throw new Error("Inserted file was not returned");
    await drizzle(env.DB)
      .delete(secureUploadSessions)
      .where(eq(secureUploadSessions.uploadId, capability.uploadId));
    return acceptsPlainText(request)
      ? plainText("ok\n", { status: 201 })
      : json({ file }, { status: 201 });
  } catch {
    await Promise.allSettled([
      env.FILES.delete(objectKey),
      drizzle(env.DB).delete(files).where(eq(files.id, capability.fileId)),
      drizzle(env.DB)
        .delete(secureUploadSessions)
        .where(eq(secureUploadSessions.uploadId, capability.uploadId)),
    ]);
    return error(500, "metadata_write_failed", "Drive could not save the uploaded file. Retry.");
  }
}

async function abortUpload(env: SecureUploadEnv, capability: SecureUploadSessionCapability) {
  try {
    await env.FILES.resumeMultipartUpload(
      `files/${capability.fileId}`,
      capability.uploadId,
    ).abort();
    await drizzle(env.DB)
      .delete(secureUploadSessions)
      .where(eq(secureUploadSessions.uploadId, capability.uploadId));
    return json({ ok: true });
  } catch {
    return error(503, "multipart_abort_failed", "Drive could not cancel the upload.");
  }
}

export async function handleSecureUploadRequest(env: SecureUploadEnv, request: Request) {
  const url = new URL(request.url);
  const clientMatch = url.pathname.match(/^\/api\/secure-uploads\/client\/([^/]+)\.sh$/u);
  if (clientMatch && request.method === "GET") {
    if (!(await validStartCapability(env, clientMatch[1]))) {
      return error(401, "invalid_or_expired_token", "Upload token is invalid or expired.");
    }
    return new Response(bashUploader(url.origin, clientMatch[1]), {
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": 'inline; filename="shedflare-upload.sh"',
      },
    });
  }

  const startMatch = url.pathname.match(/^\/api\/secure-uploads\/start\/([^/]+)$/u);
  if (startMatch && request.method === "POST") {
    return await startUpload(env, request, startMatch[1]);
  }

  const partMatch = url.pathname.match(
    /^\/api\/secure-uploads\/session\/([^/]+)\/parts\/([0-9]+)$/u,
  );
  if (partMatch && request.method === "PUT") {
    const capability = await validSessionCapability(env, partMatch[1]);
    if (!capability)
      return error(401, "invalid_or_expired_session", "Upload session is invalid or expired.");
    return await uploadPart(env, request, capability, Number(partMatch[2]));
  }

  const completeMatch = url.pathname.match(/^\/api\/secure-uploads\/session\/([^/]+)\/complete$/u);
  if (completeMatch && request.method === "POST") {
    const capability = await validSessionCapability(env, completeMatch[1]);
    if (!capability)
      return error(401, "invalid_or_expired_session", "Upload session is invalid or expired.");
    return await completeUpload(env, request, capability);
  }

  const abortMatch = url.pathname.match(/^\/api\/secure-uploads\/session\/([^/]+)$/u);
  if (abortMatch && request.method === "DELETE") {
    const capability = await verifiedSessionCapability(env, abortMatch[1]);
    if (!capability)
      return error(401, "invalid_or_expired_session", "Upload session is invalid or expired.");
    return await abortUpload(env, capability);
  }

  return null;
}

export function createSecureUploadHandlersGroup(env: SecureUploadEnv, auth: HttpApiAuth) {
  return HttpApiBuilder.group(driveApi, "secureUploads", (handlers) =>
    handlers.handle("createCommand", (ctx) =>
      auth.createProtectedHandler(async (request) => {
        const expiresAtMs = commandExpiry(await request.json().catch(() => null));
        if (expiresAtMs === null) {
          return HttpServerResponse.fromWeb(
            error(400, "invalid_expiry", "Expiry must be an integer from 30 to 900 seconds."),
          );
        }

        await cleanupExpiredSecureUploads(env);
        const nonce = crypto.randomUUID();
        await drizzle(env.DB).insert(secureUploadStartCapabilities).values({
          nonce,
          expiresAt: expiresAtMs,
          createdAt: Date.now(),
        });
        const token = await signSecureUploadCapability(env, {
          kind: "secure-upload-start",
          expiresAt: expiresAtMs,
          maxBytes: SECURE_UPLOAD_MAX_BYTES,
          nonce,
        });
        const clientUrl = new URL(
          `/api/secure-uploads/client/${encodeURIComponent(token)}.sh`,
          request.url,
        );
        return {
          command: `bash -o pipefail -c 'curl -fsSL "$1" | bash -s -- "$2"' -- '${clientUrl.toString()}' "<path-to-file>"`,
          clientUrl: clientUrl.toString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
          maxBytes: SECURE_UPLOAD_MAX_BYTES,
        };
      })(ctx),
    ),
  );
}
