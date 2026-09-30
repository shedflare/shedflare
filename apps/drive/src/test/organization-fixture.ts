import { drizzle } from "drizzle-orm/d1";
import { createRouter, type Env } from "../server/router";
import { files, tags, fileTags } from "../db/schema";
import { createTestD1, asD1Database } from "./d1-shim";
import { R2Mock, asR2Bucket } from "./r2-mock";

export async function organizationFixture() {
  const db = createTestD1();
  const database = asD1Database(db);
  const now = new Date(0).toISOString();
  await drizzle(database)
    .insert(files)
    .values([
      {
        id: "report",
        objectKey: "report",
        name: "Report.pdf",
        mimeType: "application/pdf",
        size: 10,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "image",
        objectKey: "image",
        name: "Photo.png",
        mimeType: "image/png",
        size: 20,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  await drizzle(database).insert(tags).values({ id: "work", name: "work", normalizedName: "work" });
  await drizzle(database).insert(fileTags).values({ fileId: "image", tagId: "work" });
  const r2 = new R2Mock();
  const env: Env = {
    DB: database,
    FILES: asR2Bucket(r2),
    AUTH: {
      async validateSession() {
        throw new Error("Unexpected Auth RPC in local fixture");
      },
      async exchangeCode() {
        throw new Error("Unexpected Auth RPC in local fixture");
      },
      async revokeSession() {
        throw new Error("Unexpected Auth RPC in local fixture");
      },
    },
    AUTH_URL: "https://auth.example.test",
    AUTH_CLIENT_ID: "drive-test",
    APP_PUBLIC_URL: "http://localhost",
    OWNER_EMAIL: "owner@example.test",
    DEV_AUTH_EMAIL: "owner@example.test",
    SECURE_UPLOAD_TOKEN_SECRET: "local-fixture-secret-at-least-32-characters",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const router = createRouter(env);
  const request = (input: RequestInfo | URL, init?: RequestInit) =>
    router.fetch(
      new Request(new URL(input instanceof Request ? input.url : input, "http://localhost"), init),
    );
  return { db, router, request, r2 };
}
