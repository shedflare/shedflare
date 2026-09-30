import type { AuthRpc } from "@shedflare/auth-client/contract";
import { drizzle } from "drizzle-orm/d1";
import { asD1Database, createTestD1, type D1Shim } from "./d1-shim";
import { R2Mock, createR2Mock } from "./r2-mock";
import { files, tags, fileTags } from "../db/schema";

export type TestEnv = {
  DB: D1Shim;
  FILES: R2Mock;
  AUTH: AuthRpc;
  AUTH_URL: string;
  AUTH_CLIENT_ID: string;
  APP_PUBLIC_URL: string;
  SECURE_UPLOAD_TOKEN_SECRET: string;
  OWNER_EMAIL: string;
  DEV_AUTH_EMAIL: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export function createTestEnv(overrides?: Partial<TestEnv>): TestEnv {
  return {
    DB: createTestD1(),
    FILES: createR2Mock(),
    AUTH: {
      async validateSession() {
        throw new Error("Unexpected Auth RPC in local test");
      },
      async exchangeCode() {
        throw new Error("Unexpected Auth RPC in local test");
      },
      async revokeSession() {
        throw new Error("Unexpected Auth RPC in local test");
      },
    },
    AUTH_URL: "https://auth.test.example.com",
    AUTH_CLIENT_ID: "shedflare-drive-test",
    APP_PUBLIC_URL: "https://drive.test.example.com",
    SECURE_UPLOAD_TOKEN_SECRET: "test-secure-upload-token-secret-at-least-32-bytes",
    OWNER_EMAIL: "test@example.com",
    DEV_AUTH_EMAIL: "test@example.com",
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    ...overrides,
  };
}

export function insertTestFile(
  d1: D1Shim,
  overrides?: Partial<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    description: string;
    isPublic: boolean;
  }>,
) {
  const db = drizzle(asD1Database(d1));
  const id = overrides?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  void db.insert(files).values({
    id,
    objectKey: `files/${id}`,
    name: overrides?.name ?? "test-file.txt",
    mimeType: overrides?.mimeType ?? "text/plain",
    size: overrides?.size ?? 1024,
    description: overrides?.description ?? "",
    isPublic: overrides?.isPublic ?? false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export function insertTestTag(d1: D1Shim, name: string) {
  const db = drizzle(asD1Database(d1));
  const id = crypto.randomUUID();
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, " ");
  void db.insert(tags).values({ id, name, normalizedName: normalized });
  return id;
}

export function linkFileTag(d1: D1Shim, fileId: string, tagId: string) {
  const db = drizzle(asD1Database(d1));
  void db.insert(fileTags).values({ fileId, tagId });
}

export { R2Mock };
export type { D1Shim };
