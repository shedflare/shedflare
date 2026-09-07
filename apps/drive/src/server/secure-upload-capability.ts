const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SECURE_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
export const SECURE_UPLOAD_PART_SIZE = 10 * 1024 * 1024;

const SafeNonNegativeIntegerSchema = pipe(number(), integer(), minValue(0));
const SecureUploadStartCapabilitySchema = object({
  kind: literal("secure-upload-start"),
  expiresAt: SafeNonNegativeIntegerSchema,
  maxBytes: literal(SECURE_UPLOAD_MAX_BYTES),
  nonce: pipe(string(), minLength(16), maxLength(128)),
});
const SecureUploadSessionCapabilitySchema = object({
  kind: literal("secure-upload-session"),
  expiresAt: SafeNonNegativeIntegerSchema,
  fileId: string(),
  uploadId: pipe(string(), minLength(1), maxLength(2_048)),
  size: pipe(SafeNonNegativeIntegerSchema, maxValue(SECURE_UPLOAD_MAX_BYTES)),
  metadataDigest: pipe(string(), length(43)),
});
const SecureUploadCapabilitySchema = union([
  SecureUploadStartCapabilitySchema,
  SecureUploadSessionCapabilitySchema,
]);
const FileDownloadCapabilitySchema = object({
  kind: literal("file-download"),
  expiresAt: SafeNonNegativeIntegerSchema,
  fileId: pipe(string(), minLength(1)),
  objectKey: pipe(string(), minLength(1)),
});
const TransferCapabilitySchema = union([
  SecureUploadCapabilitySchema,
  FileDownloadCapabilitySchema,
]);
type TransferCapability = InferOutput<typeof TransferCapabilitySchema>;
type FileDownloadCapability = InferOutput<typeof FileDownloadCapabilitySchema>;

export type SecureUploadStartCapability = InferOutput<typeof SecureUploadStartCapabilitySchema>;
export type SecureUploadSessionCapability = InferOutput<typeof SecureUploadSessionCapabilitySchema>;
export type SecureUploadCapability = InferOutput<typeof SecureUploadCapabilitySchema>;

type CapabilityEnv = {
  SECURE_UPLOAD_TOKEN_SECRET: string;
};

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(env: CapabilityEnv, usage: KeyUsage[]) {
  if (env.SECURE_UPLOAD_TOKEN_SECRET.length < 32) {
    throw new Error("SECURE_UPLOAD_TOKEN_SECRET must contain at least 32 characters");
  }
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SECURE_UPLOAD_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

function parseCapability<Value>(value: Value): TransferCapability | null {
  const result = safeParse(TransferCapabilitySchema, value);
  return result.success ? result.output : null;
}

async function signCapability(env: CapabilityEnv, capability: TransferCapability) {
  const payload = encoder.encode(JSON.stringify(capability));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env, ["sign"]), payload);
  return `${encodeBase64Url(payload)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyCapability(env: CapabilityEnv, token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const payload = decodeBase64Url(parts[0]);
    const signature = decodeBase64Url(parts[1]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env, ["verify"]),
      signature,
      payload,
    );
    if (!valid) return null;
    return parseCapability(JSON.parse(decoder.decode(payload)));
  } catch {
    return null;
  }
}

export function signSecureUploadCapability(env: CapabilityEnv, capability: SecureUploadCapability) {
  return signCapability(env, capability);
}

export async function verifySecureUploadCapability(env: CapabilityEnv, token: string) {
  const capability = await verifyCapability(env, token);
  return capability?.kind === "file-download" ? null : capability;
}

export function signFileDownloadCapability(env: CapabilityEnv, capability: FileDownloadCapability) {
  return signCapability(env, capability);
}

export async function verifyFileDownloadCapability(env: CapabilityEnv, token: string) {
  const capability = await verifyCapability(env, token);
  return capability?.kind === "file-download" ? capability : null;
}

export async function secureUploadMetadataDigest(metadata: {
  name: string;
  mimeType: string;
  size: number;
}) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(metadata)));
  return encodeBase64Url(new Uint8Array(digest));
}
import {
  integer,
  length,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  pipe,
  safeParse,
  string,
  union,
  type InferOutput,
} from "valibot";
