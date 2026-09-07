import { and, desc, eq, inArray, like as likeOp, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { fileTags, files, tags } from "../../db/schema";
import { driveApi } from "../definitions";
import { commandExpiry } from "../command-expiry";
import {
  signFileDownloadCapability,
  verifyFileDownloadCapability,
} from "../secure-upload-capability";
import type { HandlerContext, HttpApiAuth } from "@shedflare/auth-client/http-api";
import type { Session } from "@shedflare/auth-client/consumer";
import { normalizeTag, parseByteRange, parseUpdateBody, publicFile } from "./file-utils";
import { array, looseObject, number, optional, safeParse, string, union } from "valibot";

type Db = DrizzleD1Database;

const MEBIBYTE = 1024 * 1024;
export const MULTIPART_PART_SIZE = 10 * MEBIBYTE;
export const SINGLE_UPLOAD_MAX_BYTES = 20 * MEBIBYTE;
const MAX_MULTIPART_PARTS = 10_000;
const MAX_MULTIPART_FILE_BYTES = MULTIPART_PART_SIZE * MAX_MULTIPART_PARTS;

type UploadMetadata = {
  name: string;
  mimeType: string;
  size: number;
  description: string;
  tags: string[];
};

function jsonResponse<Body>(body: Body, status = 200) {
  return HttpServerResponse.fromWeb(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function errorResponse(status: number, code: string, error: string, retryable = false) {
  return jsonResponse({ code, error, retryable }, status);
}

const TagsInputSchema = union([string(), array(string())]);
const UploadMetadataSchema = looseObject({
  name: string(),
  mimeType: optional(string(), "application/octet-stream"),
  description: optional(string(), ""),
  size: number(),
  tags: optional(TagsInputSchema),
});
const UploadedPartSchema = looseObject({ partNumber: number(), etag: string() });
const CompleteUploadSchema = looseObject({
  uploadId: string(),
  parts: array(UploadedPartSchema),
});

function parseTags<Value>(value: Value): string[] {
  const result = safeParse(TagsInputSchema, value);
  if (!result.success) return [];
  const values = Array.isArray(result.output) ? result.output : result.output.split(",");
  return Array.from(new Set(values.map(normalizeTag).filter(Boolean))).slice(0, 20);
}

function parseUploadMetadata<Value>(value: Value): UploadMetadata | null {
  const result = safeParse(UploadMetadataSchema, value);
  if (!result.success) return null;
  const name = result.output.name.trim();
  const mimeType = result.output.mimeType.trim() || "application/octet-stream";
  const description = result.output.description.trim();
  const size = result.output.size;

  if (
    !name ||
    name.length > 512 ||
    mimeType.length > 255 ||
    description.length > 10_000 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_MULTIPART_FILE_BYTES
  ) {
    return null;
  }

  return { name, mimeType, size, description, tags: parseTags(result.output.tags) };
}

function uploadIdFrom(request: Request) {
  const uploadId = request.headers.get("x-shedflare-upload-id")?.trim() ?? "";
  return uploadId && uploadId.length <= 2_048 ? uploadId : null;
}

function isFileId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseUploadedParts<Value>(value: Value): R2UploadedPart[] | null {
  const result = safeParse(array(UploadedPartSchema), value);
  if (!result.success || result.output.length === 0 || result.output.length > MAX_MULTIPART_PARTS) {
    return null;
  }

  const parts: R2UploadedPart[] = [];
  for (const [index, part] of result.output.entries()) {
    if (part.partNumber !== index + 1 || !part.etag || part.etag.length > 256) {
      return null;
    }
    parts.push({ partNumber: part.partNumber, etag: part.etag });
  }
  return parts;
}

async function setFileTags(db: Db, fileId: string, tagNames: string[]) {
  await db.delete(fileTags).where(eq(fileTags.fileId, fileId));
  if (tagNames.length === 0) return;

  await db
    .insert(tags)
    .values(
      tagNames.map((tag) => ({
        id: crypto.randomUUID(),
        name: tag,
        normalizedName: tag,
      })),
    )
    .onConflictDoNothing({ target: tags.normalizedName });

  const storedTags = await db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(tags.normalizedName, tagNames))
    .all();
  if (storedTags.length > 0) {
    await db
      .insert(fileTags)
      .values(storedTags.map((tag) => ({ fileId, tagId: tag.id })))
      .onConflictDoNothing();
  }
}

async function getFile(db: Db, id: string) {
  return await db
    .select({
      id: files.id,
      objectKey: files.objectKey,
      name: files.name,
      mimeType: files.mimeType,
      size: files.size,
      description: files.description,
      isPublic: files.isPublic,
      createdAt: files.createdAt,
      updatedAt: files.updatedAt,
      tags: sql<string | null>`group_concat(${tags.name})`,
    })
    .from(files)
    .leftJoin(fileTags, eq(fileTags.fileId, files.id))
    .leftJoin(tags, eq(tags.id, fileTags.tagId))
    .where(eq(files.id, id))
    .groupBy(files.id)
    .get();
}

async function persistFile(
  db: Db,
  input: UploadMetadata & { id: string; objectKey: string; now: string },
) {
  await db.insert(files).values({
    id: input.id,
    objectKey: input.objectKey,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    description: input.description,
    isPublic: false,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await setFileTags(db, input.id, input.tags);
  return await getFile(db, input.id);
}

type FileEnv = { DB: D1Database; FILES: R2Bucket };
type CliFileEnv = FileEnv & { SECURE_UPLOAD_TOKEN_SECRET: string };
type FileParams = { id: string };
type MultipartPartParams = FileParams & { partNumber: string };

type StoredFile = {
  objectKey: string;
  name: string;
  size: number;
};

async function serveStoredFile(options: {
  bucket: R2Bucket;
  file: StoredFile;
  request: Request;
  disposition: "inline" | "download";
}) {
  const { bucket, file, request, disposition } = options;
  const requestedRange = parseByteRange(request.headers.get("range"), file.size);
  if (requestedRange.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "accept-ranges": "bytes",
        "content-range": `bytes */${file.size}`,
      },
    });
  }

  const object = await bucket.get(
    file.objectKey,
    requestedRange.kind === "partial"
      ? { range: { offset: requestedRange.offset, length: requestedRange.length } }
      : undefined,
  );
  if (!object) return new Response("File object missing", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set(
    "content-disposition",
    disposition === "download"
      ? `attachment; filename="${file.name.replaceAll('"', "'")}"`
      : "inline",
  );

  if (requestedRange.kind === "partial") {
    const end = requestedRange.offset + requestedRange.length - 1;
    headers.set("content-length", String(requestedRange.length));
    headers.set("content-range", `bytes ${requestedRange.offset}-${end}/${file.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

type ProtectedHandler<Params, Result> = (
  webReq: Request,
  session: Session,
  context: HandlerContext<Params>,
) => Promise<Result>;

function protectFile<Result>(auth: HttpApiAuth, handler: ProtectedHandler<FileParams, Result>) {
  return auth.createProtectedHandler<FileParams, unknown, Result>(handler);
}

function protectMultipartPart<Result>(
  auth: HttpApiAuth,
  handler: ProtectedHandler<MultipartPartParams, Result>,
) {
  return auth.createProtectedHandler<MultipartPartParams, unknown, Result>(handler);
}

export async function listPublicFiles(env: FileEnv, _request: Request) {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: files.id,
      name: files.name,
      mimeType: files.mimeType,
      size: files.size,
      description: files.description,
      isPublic: files.isPublic,
      createdAt: files.createdAt,
      updatedAt: files.updatedAt,
      tags: sql<string | null>`group_concat(${tags.name})`,
    })
    .from(files)
    .leftJoin(fileTags, eq(fileTags.fileId, files.id))
    .leftJoin(tags, eq(tags.id, fileTags.tagId))
    .where(eq(files.isPublic, true))
    .groupBy(files.id)
    .orderBy(desc(files.createdAt))
    .all();

  return new Response(JSON.stringify({ files: rows.map(publicFile) }), {
    headers: { "content-type": "application/json" },
  });
}

export async function servePublicFile(
  env: FileEnv,
  id: string,
  disposition: "inline" | "download",
  request: Request,
) {
  const db = drizzle(env.DB);
  const row = await getFile(db, id);
  if (!row || !row.isPublic) return new Response("Not found", { status: 404 });

  return await serveStoredFile({ bucket: env.FILES, file: row, request, disposition });
}

export async function serveCliDownload(env: CliFileEnv, request: Request, id: string) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const capability = await verifyFileDownloadCapability(env, token);
  const privateHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (!capability || capability.fileId !== id || capability.expiresAt <= Date.now()) {
    return new Response("Download command is invalid or expired. Create a new one in Drive.", {
      status: 401,
      headers: privateHeaders,
    });
  }
  const row = await getFile(drizzle(env.DB), id);
  if (!row || row.objectKey !== capability.objectKey) {
    return new Response("Not found", { status: 404, headers: privateHeaders });
  }
  const response = await serveStoredFile({
    bucket: env.FILES,
    file: row,
    request,
    disposition: "download",
  });
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

export function createFileHandlersGroup(env: CliFileEnv, auth: HttpApiAuth) {
  return HttpApiBuilder.group(driveApi, "files", (handlers) =>
    handlers
      .handle("list", (ctx) =>
        auth.createProtectedHandler(async (webReq) => {
          const db = drizzle(env.DB);
          const url = new URL(webReq.url);
          const search = url.searchParams.get("search")?.trim() ?? "";
          const tag = normalizeTag(url.searchParams.get("tag") ?? "");
          const rawLimit = parseInt(url.searchParams.get("limit") ?? "30", 10);
          const limit = Math.min(Math.max(isNaN(rawLimit) ? 30 : rawLimit, 1), 100);
          const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
          const offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);

          const searchLike = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
          const searchWhere = search
            ? or(
                likeOp(files.name, searchLike),
                likeOp(files.description, searchLike),
                likeOp(files.mimeType, searchLike),
                sql`${files.id} IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name LIKE ${searchLike} ESCAPE '\\')`,
              )
            : undefined;
          const tagWhere = tag
            ? sql`${files.id} IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.normalized_name = ${tag})`
            : undefined;
          const rows = await db
            .select({
              id: files.id,
              name: files.name,
              mimeType: files.mimeType,
              size: files.size,
              description: files.description,
              isPublic: files.isPublic,
              createdAt: files.createdAt,
              updatedAt: files.updatedAt,
              tags: sql<string | null>`group_concat(${tags.name})`,
            })
            .from(files)
            .leftJoin(fileTags, eq(fileTags.fileId, files.id))
            .leftJoin(tags, eq(tags.id, fileTags.tagId))
            .where(and(searchWhere, tagWhere))
            .groupBy(files.id)
            .orderBy(desc(files.createdAt))
            .limit(limit + 1)
            .offset(offset)
            .all();

          const hasMore = rows.length > limit;
          const pageRows = hasMore ? rows.slice(0, limit) : rows;
          return {
            files: pageRows.map(publicFile),
            nextOffset: hasMore ? offset + limit : null,
          };
        })(ctx),
      )
      .handle("create", (ctx) =>
        auth.createProtectedHandler(async (webReq) => {
          const db = drizzle(env.DB);
          const contentLength = Number(webReq.headers.get("content-length") ?? "0");
          if (Number.isFinite(contentLength) && contentLength > SINGLE_UPLOAD_MAX_BYTES) {
            return errorResponse(
              413,
              "single_upload_too_large",
              "This request is too large for a single upload. Use Drive's chunked upload flow.",
            );
          }

          const form = await webReq.formData().catch(() => null);
          if (!form) {
            return errorResponse(
              400,
              "invalid_multipart_form",
              "The upload form could not be read. Select the file again and retry.",
            );
          }
          const file = form.get("file");
          if (!(file instanceof File)) {
            return errorResponse(400, "missing_file", "Choose a file to upload.");
          }
          if (file.size > SINGLE_UPLOAD_MAX_BYTES) {
            return errorResponse(
              413,
              "single_upload_too_large",
              "This file is too large for a single upload. Use Drive's chunked upload flow.",
            );
          }

          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const formName = form.get("name");
          const formDescription = form.get("description");
          const parsedName = safeParse(string(), formName);
          const parsedDescription = safeParse(string(), formDescription);
          const name = parsedName.success ? parsedName.output.trim() : file.name;
          const description = parsedDescription.success ? parsedDescription.output.trim() : "";
          const tagNames = parseTags(form.get("tags"));
          const objectKey = `files/${id}`;
          const metadata: UploadMetadata = {
            name: name || file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            description,
            tags: tagNames,
          };

          try {
            await env.FILES.put(objectKey, file.stream(), {
              httpMetadata: { contentType: metadata.mimeType },
            });
          } catch {
            return errorResponse(
              503,
              "storage_write_failed",
              "Drive could not write the file to storage. Retry the upload.",
              true,
            );
          }

          try {
            const row = await persistFile(db, { ...metadata, id, objectKey, now });
            if (!row) throw new Error("File row was not returned after insert");
            return jsonResponse({ file: publicFile(row) }, 201);
          } catch {
            await Promise.allSettled([
              env.FILES.delete(objectKey),
              db.delete(files).where(eq(files.id, id)),
            ]);
            return errorResponse(
              500,
              "metadata_write_failed",
              "The file reached storage, but Drive could not save its details. Nothing was kept; retry the upload.",
              true,
            );
          }
        })(ctx),
      )
      .handle("multipartCreate", (ctx) =>
        auth.createProtectedHandler(async (webReq) => {
          const body = await webReq.json().catch(() => null);
          const metadata = parseUploadMetadata(body);
          if (!metadata) {
            return errorResponse(
              400,
              "invalid_upload_metadata",
              `Provide a valid file name, MIME type, and size no larger than ${MAX_MULTIPART_FILE_BYTES} bytes.`,
            );
          }

          const fileId = crypto.randomUUID();
          try {
            const upload = await env.FILES.createMultipartUpload(`files/${fileId}`, {
              httpMetadata: { contentType: metadata.mimeType },
            });
            return jsonResponse(
              { fileId, uploadId: upload.uploadId, partSize: MULTIPART_PART_SIZE },
              201,
            );
          } catch {
            return errorResponse(
              503,
              "multipart_create_failed",
              "Drive could not start the large-file upload. Retry in a moment.",
              true,
            );
          }
        })(ctx),
      )
      .handle("multipartPart", (ctx) =>
        protectMultipartPart(auth, async (webReq, _session, handlerCtx) => {
          const idParam = handlerCtx.params?.id;
          const partNumberParam = handlerCtx.params?.partNumber;
          const parsedId = safeParse(string(), idParam);
          const parsedPartNumber = safeParse(string(), partNumberParam);
          const id = parsedId.success ? parsedId.output : "";
          const partNumber = parsedPartNumber.success
            ? Number(parsedPartNumber.output)
            : Number.NaN;
          const uploadId = uploadIdFrom(webReq);
          const contentLength = Number(webReq.headers.get("content-length") ?? "0");

          if (
            !isFileId(id) ||
            !uploadId ||
            !Number.isInteger(partNumber) ||
            partNumber < 1 ||
            partNumber > MAX_MULTIPART_PARTS
          ) {
            return errorResponse(
              400,
              "invalid_upload_part",
              "The upload part identifier is invalid. Restart the upload.",
            );
          }
          if (Number.isFinite(contentLength) && contentLength > MULTIPART_PART_SIZE) {
            return errorResponse(
              413,
              "upload_part_too_large",
              `Upload parts must be no larger than ${MULTIPART_PART_SIZE} bytes.`,
            );
          }
          if (!webReq.body) {
            return errorResponse(400, "missing_upload_part", "The upload part has no content.");
          }

          try {
            const upload = env.FILES.resumeMultipartUpload(`files/${id}`, uploadId);
            const part = await upload.uploadPart(partNumber, webReq.body);
            return jsonResponse(part);
          } catch {
            return errorResponse(
              503,
              "upload_part_failed",
              `Drive could not store upload part ${partNumber}. It is safe to retry this part.`,
              true,
            );
          }
        })(ctx),
      )
      .handle("multipartComplete", (ctx) =>
        protectFile(auth, async (webReq, _session, handlerCtx) => {
          const db = drizzle(env.DB);
          const idParam = handlerCtx.params?.id;
          const parsedId = safeParse(string(), idParam);
          const id = parsedId.success ? parsedId.output : "";
          const body = await webReq.json().catch(() => null);
          const metadata = parseUploadMetadata(body);
          const completion = safeParse(CompleteUploadSchema, body);
          const uploadId = completion.success ? completion.output.uploadId : null;
          const parts = completion.success ? parseUploadedParts(completion.output.parts) : null;

          if (
            !isFileId(id) ||
            !uploadId ||
            uploadId.length > 2_048 ||
            !metadata ||
            !parts ||
            parts.length !== Math.max(1, Math.ceil(metadata.size / MULTIPART_PART_SIZE))
          ) {
            return errorResponse(
              400,
              "invalid_multipart_completion",
              "The upload manifest is incomplete or invalid. Restart the upload.",
            );
          }

          const existing = await getFile(db, id);
          if (existing) return jsonResponse({ file: publicFile(existing) });

          const objectKey = `files/${id}`;
          try {
            const upload = env.FILES.resumeMultipartUpload(objectKey, uploadId);
            const object = await upload.complete(parts);
            if (object.size !== metadata.size) {
              await env.FILES.delete(objectKey);
              return errorResponse(
                400,
                "upload_size_mismatch",
                `The uploaded file was incomplete: expected ${metadata.size} bytes but received ${object.size}. Retry the upload.`,
                true,
              );
            }
          } catch {
            return errorResponse(
              503,
              "multipart_complete_failed",
              "Drive could not finalize the large-file upload. Retry once; if it still fails, restart the upload.",
              true,
            );
          }

          try {
            const row = await persistFile(db, {
              ...metadata,
              id,
              objectKey,
              now: new Date().toISOString(),
            });
            if (!row) throw new Error("File row was not returned after insert");
            return jsonResponse({ file: publicFile(row) }, 201);
          } catch {
            await Promise.allSettled([
              env.FILES.delete(objectKey),
              db.delete(files).where(eq(files.id, id)),
            ]);
            return errorResponse(
              500,
              "metadata_write_failed",
              "The upload finished, but Drive could not save its details. Nothing was kept; retry the upload.",
              true,
            );
          }
        })(ctx),
      )
      .handle("multipartAbort", (ctx) =>
        protectFile(auth, async (webReq, _session, handlerCtx) => {
          const idParam = handlerCtx.params?.id;
          const parsedId = safeParse(string(), idParam);
          const id = parsedId.success ? parsedId.output : "";
          const uploadId = uploadIdFrom(webReq);
          if (!isFileId(id) || !uploadId) {
            return errorResponse(
              400,
              "invalid_multipart_abort",
              "The upload identifier is invalid.",
            );
          }

          try {
            await env.FILES.resumeMultipartUpload(`files/${id}`, uploadId).abort();
            return { ok: true };
          } catch {
            return errorResponse(
              503,
              "multipart_abort_failed",
              "Drive could not cancel the stored upload parts. They will expire automatically.",
              true,
            );
          }
        })(ctx),
      )
      .handle("update", (ctx) =>
        protectFile(auth, async (webReq, _session, handlerCtx) => {
          const db = drizzle(env.DB);
          const id = handlerCtx.params?.id ?? "";
          const current = await getFile(db, id);
          if (!current)
            return HttpServerResponse.fromWeb(new Response("Not found", { status: 404 }));

          const rawBody = await webReq.json().catch(() => null);
          const body = parseUpdateBody(rawBody);
          if (!body) {
            return HttpServerResponse.fromWeb(
              new Response(JSON.stringify({ error: "Invalid request body" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              }),
            );
          }

          const name = body.name?.trim() || current.name;
          const description = body.description?.trim() ?? current.description ?? "";
          const isPublic = body.isPublic ?? Boolean(current.isPublic);
          const tagNames: string[] = body.tags
            ? Array.from(new Set(body.tags.map(normalizeTag).filter(Boolean))).slice(0, 20)
            : (current.tags?.split(",") ?? []);
          const now = new Date().toISOString();

          await db
            .update(files)
            .set({ name, description, isPublic, updatedAt: now })
            .where(eq(files.id, id));
          await setFileTags(db, id, tagNames);

          const row = await getFile(db, id);
          if (!row) return HttpServerResponse.fromWeb(new Response("Not found", { status: 404 }));
          return { file: publicFile(row) };
        })(ctx),
      )
      .handle("delete", (ctx) =>
        protectFile(auth, async (_webReq, _session, handlerCtx) => {
          const db = drizzle(env.DB);
          const id = handlerCtx.params?.id ?? "";
          const row = await getFile(db, id);
          if (!row) return HttpServerResponse.fromWeb(new Response("Not found", { status: 404 }));
          await env.FILES.delete(row.objectKey);
          await db.delete(files).where(eq(files.id, id));
          return { ok: true };
        })(ctx),
      )
      .handle("downloadCommand", (ctx) =>
        protectFile(auth, async (request, _session, handlerCtx) => {
          const expiresAt = commandExpiry(await request.json().catch(() => null));
          if (expiresAt === null) {
            return errorResponse(
              400,
              "invalid_expiry",
              "Expiry must be an integer from 30 to 900 seconds.",
            );
          }
          const id = handlerCtx.params?.id ?? "";
          const row = await getFile(drizzle(env.DB), id);
          if (!row)
            return errorResponse(404, "file_not_found", "The requested file no longer exists");
          const token = await signFileDownloadCapability(env, {
            kind: "file-download",
            fileId: id,
            objectKey: row.objectKey,
            expiresAt,
          });
          const url = new URL(`/api/cli-downloads/${encodeURIComponent(id)}`, request.url);
          url.searchParams.set("token", token);
          return HttpServerResponse.fromWeb(
            new Response(
              JSON.stringify({
                downloadUrl: url.toString(),
                expiresAt: new Date(expiresAt).toISOString(),
              }),
              { headers: { "content-type": "application/json", "cache-control": "no-store" } },
            ),
          );
        })(ctx),
      )
      .handle("download", (ctx) =>
        protectFile(auth, async (_webReq, _session, handlerCtx) => {
          const db = drizzle(env.DB);
          const id = handlerCtx.params?.id ?? "";
          const row = await getFile(db, id);
          if (!row) return HttpServerResponse.fromWeb(new Response("Not found", { status: 404 }));

          const object = await env.FILES.get(row.objectKey);
          if (!object)
            return HttpServerResponse.fromWeb(new Response("File object missing", { status: 404 }));

          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("content-length", String(object.size));
          headers.set(
            "content-disposition",
            `attachment; filename="${row.name.replaceAll('"', "'")}"`,
          );
          return HttpServerResponse.fromWeb(new Response(object.body, { headers }));
        })(ctx),
      )
      .handle("preview", (ctx) =>
        protectFile(auth, async (webReq, _session, handlerCtx) => {
          const db = drizzle(env.DB);
          const id = handlerCtx.params?.id ?? "";
          const row = await getFile(db, id);
          if (!row) return HttpServerResponse.fromWeb(new Response("Not found", { status: 404 }));

          return HttpServerResponse.fromWeb(
            await serveStoredFile({
              bucket: env.FILES,
              file: row,
              request: webReq,
              disposition: "inline",
            }),
          );
        })(ctx),
      ),
  );
}
