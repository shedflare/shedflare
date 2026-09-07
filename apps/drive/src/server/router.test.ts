import { describe, expect, test, beforeEach } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as Schema from "effect/Schema";
import { createRouter, type Env } from "./router";
import { files as fileRecords, secureUploadSessions } from "../db/schema";
import { asD1Database, createTestD1, D1Shim } from "../test/d1-shim";
import { asR2Bucket, R2Mock } from "../test/r2-mock";
import {
  DeleteResponse,
  CliDownloadCommandResponse,
  FileResponse,
  FilesResponse,
  MultipartPartResponse,
  MultipartUploadResponse,
  SecureUploadCommandResponse,
  TagsResponse,
} from "../shared/schema";
import { MULTIPART_PART_SIZE, SINGLE_UPLOAD_MAX_BYTES } from "./impl/files";
import {
  SECURE_UPLOAD_MAX_BYTES,
  SECURE_UPLOAD_PART_SIZE,
  signSecureUploadCapability,
  signFileDownloadCapability,
} from "./secure-upload-capability";

const SecureUploadSessionResponse = Schema.Struct({ sessionToken: Schema.String });

describe("CLI download commands", () => {
  const secret = "test-secure-upload-token-secret-at-least-32-bytes";

  async function fixture() {
    const db = createTestD1();
    const env = makeTestEnv(db, new R2Mock());
    const ownerRouter = createRouter(env);
    const form = new FormData();
    form.set("file", new File(["private file contents"], "report.txt", { type: "text/plain" }));
    const created = await decodeJson(
      await ownerRouter.fetch(makeRequest("/api/files", { method: "POST", body: form })),
      FileResponse,
    );
    const file = created.file;
    const response = await ownerRouter.fetch(
      makeRequest(`/api/files/${file.id}/download-command`, {
        method: "POST",
        body: JSON.stringify({ expiresInSeconds: 120 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const command = await decodeJson(response, CliDownloadCommandResponse);
    const anonymousRouter = createRouter({ ...env, DEV_AUTH_EMAIL: undefined });
    return { db, env, ownerRouter, anonymousRouter, file, command };
  }

  test("a command downloads a private file without login and supports byte ranges", async () => {
    const { anonymousRouter, file, command } = await fixture();
    const response = await anonymousRouter.fetch(new Request(command.downloadUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("private file contents");
    const range = await anonymousRouter.fetch(
      new Request(command.downloadUrl, { headers: { range: "bytes=0-6" } }),
    );
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("private");
    expect(
      (await anonymousRouter.fetch(makeRequest(`/public/files/${file.id}/download`))).status,
    ).toBe(404);
    expect(Date.parse(command.expiresAt)).toBeGreaterThan(Date.now() + 110_000);
  });

  test("only the signed-in owner can issue commands", async () => {
    const { anonymousRouter, file } = await fixture();
    const response = await anonymousRouter.fetch(
      makeRequest(`/api/files/${file.id}/download-command`, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
  });

  test("missing, tampered, expired, wrong-file, and upload tokens cannot download", async () => {
    const { anonymousRouter, file, command } = await fixture();
    const original = new URL(command.downloadUrl);
    const tampered = new URL(original);
    tampered.searchParams.set("token", `x${original.searchParams.get("token")}`);
    const wrongFile = new URL(original);
    wrongFile.pathname = "/api/cli-downloads/another-file";
    const expired = new URL(original);
    expired.searchParams.set(
      "token",
      await signFileDownloadCapability(
        { SECURE_UPLOAD_TOKEN_SECRET: secret },
        {
          kind: "file-download",
          fileId: file.id,
          objectKey: "unused",
          expiresAt: Date.now() - 1,
        },
      ),
    );
    const upload = new URL(original);
    upload.searchParams.set(
      "token",
      await signSecureUploadCapability(
        { SECURE_UPLOAD_TOKEN_SECRET: secret },
        {
          kind: "secure-upload-start",
          expiresAt: Date.now() + 60_000,
          maxBytes: SECURE_UPLOAD_MAX_BYTES,
          nonce: crypto.randomUUID(),
        },
      ),
    );
    for (const url of [
      new URL(original.pathname, original),
      tampered,
      wrongFile,
      expired,
      upload,
    ]) {
      expect((await anonymousRouter.fetch(new Request(url))).status).toBe(401);
    }
    const token = original.searchParams.get("token");
    expect(
      (
        await anonymousRouter.fetch(
          makeRequest(`/api/secure-uploads/start/${token}`, { method: "POST", body: "{}" }),
        )
      ).status,
    ).toBe(401);
  });

  test("deleting the file invalidates an existing command", async () => {
    const { ownerRouter, anonymousRouter, file, command } = await fixture();
    expect(
      (await ownerRouter.fetch(makeRequest(`/api/files/${file.id}`, { method: "DELETE" }))).status,
    ).toBe(200);
    expect((await anonymousRouter.fetch(new Request(command.downloadUrl))).status).toBe(404);
  });

  test("a command cannot read replacement bytes under the same file ID", async () => {
    const { db, anonymousRouter, file, command } = await fixture();
    await drizzle(asD1Database(db))
      .update(fileRecords)
      .set({ objectKey: "replacement-object" })
      .where(eq(fileRecords.id, file.id));
    expect((await anonymousRouter.fetch(new Request(command.downloadUrl))).status).toBe(404);
  });

  test("invalid expiry and missing files cannot issue a command", async () => {
    const { ownerRouter, file } = await fixture();
    for (const expiresInSeconds of [0, 901, 1.5, "120"]) {
      expect(
        (
          await ownerRouter.fetch(
            makeRequest(`/api/files/${file.id}/download-command`, {
              method: "POST",
              body: JSON.stringify({ expiresInSeconds }),
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await ownerRouter.fetch(
          makeRequest("/api/files/missing/download-command", { method: "POST", body: "{}" }),
        )
      ).status,
    ).toBe(404);
  });
});

async function decodeJson<SchemaType extends Parameters<typeof Schema.decodeUnknownSync>[0]>(
  response: Response,
  schema: SchemaType,
): Promise<SchemaType["Type"]> {
  return Schema.decodeUnknownSync(schema)(await response.json());
}

function makeTestEnv(db: D1Shim, files: R2Mock): Env {
  return {
    DB: asD1Database(db),
    FILES: asR2Bucket(files),
    AUTH_ISSUER_URL: "https://auth.test.example.com",
    AUTH_CLIENT_ID: "shedflare-drive-test",
    APP_PUBLIC_URL: "https://drive.test.example.com",
    SECURE_UPLOAD_TOKEN_SECRET: "test-secure-upload-token-secret-at-least-32-bytes",
    OWNER_EMAIL: "test@example.com",
    DEV_AUTH_EMAIL: "test@example.com",
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
}

function makeRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

describe("file API", () => {
  let db: D1Shim;
  let r2: R2Mock;
  let router: ReturnType<typeof createRouter>;

  beforeEach(() => {
    db = createTestD1();
    r2 = new R2Mock();
    router = createRouter(makeTestEnv(db, r2));
  });

  test("GET /api/files returns empty list", async () => {
    const res = await router.fetch(makeRequest("/api/files"));
    expect(res.status).toBe(200);
    const body = await decodeJson(res, FilesResponse);
    expect(body.files).toEqual([]);
    expect(body.nextOffset).toBeNull();
  });

  test("POST /api/files creates a file", async () => {
    const form = new FormData();
    form.set("file", new File(["hello world"], "test.txt", { type: "text/plain" }));
    form.set("name", "custom-name.txt");
    form.set("description", "a test file");
    form.set("tags", "work,important");

    const res = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const body = await decodeJson(res, FileResponse);
    expect(body.file.name).toBe("custom-name.txt");
    expect(body.file.description).toBe("a test file");
    expect(body.file.tags).toContain("work");
    expect(body.file.tags).toContain("important");
  });

  test("POST /api/files uses file name when no custom name", async () => {
    const form = new FormData();
    form.set("file", new File(["content"], "original.txt", { type: "text/plain" }));

    const res = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const body = await decodeJson(res, FileResponse);
    expect(body.file.name).toBe("original.txt");
  });

  test("POST /api/files returns 400 without file", async () => {
    const form = new FormData();
    form.set("name", "no-file");

    const res = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    expect(res.status).toBe(400);
  });

  test("POST /api/files rejects oversized single-request uploads with an actionable error", async () => {
    const res = await router.fetch(
      makeRequest("/api/files", {
        method: "POST",
        headers: { "content-length": String(SINGLE_UPLOAD_MAX_BYTES + 1) },
        body: "too large",
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: "single_upload_too_large",
      retryable: false,
    });
  });

  test("multipart upload stores a large file and its metadata", async () => {
    const finalChunk = new TextEncoder().encode("final chunk");
    const size = MULTIPART_PART_SIZE + finalChunk.length;
    const createRes = await router.fetch(
      makeRequest("/api/files/multipart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "large-video.mp4",
          mimeType: "video/mp4",
          size,
          description: "large upload",
          tags: "video, archive",
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const session = await decodeJson(createRes, MultipartUploadResponse);
    expect(session.partSize).toBe(MULTIPART_PART_SIZE);

    const firstChunk = new Uint8Array(MULTIPART_PART_SIZE);
    firstChunk.fill(7);
    const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
    for (const [index, chunk] of [firstChunk, finalChunk].entries()) {
      const partNumber = index + 1;
      const partRes = await router.fetch(
        makeRequest(`/api/files/multipart/${session.fileId}/parts/${partNumber}`, {
          method: "PUT",
          headers: { "x-shedflare-upload-id": session.uploadId },
          body: chunk,
        }),
      );
      expect(partRes.status).toBe(200);
      uploadedParts.push(await decodeJson(partRes, MultipartPartResponse));
    }

    const completeRes = await router.fetch(
      makeRequest(`/api/files/multipart/${session.fileId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadId: session.uploadId,
          parts: uploadedParts,
          name: "large-video.mp4",
          mimeType: "video/mp4",
          size,
          description: "large upload",
          tags: "video, archive",
        }),
      }),
    );
    expect(completeRes.status).toBe(201);
    const completed = await decodeJson(completeRes, FileResponse);
    expect(completed.file).toMatchObject({
      id: session.fileId,
      name: "large-video.mp4",
      size,
    });
    expect(completed.file.tags.toSorted()).toEqual(["archive", "video"]);

    const downloadRes = await router.fetch(makeRequest(`/api/files/${session.fileId}/download`));
    expect(downloadRes.status).toBe(200);
    expect((await downloadRes.arrayBuffer()).byteLength).toBe(size);
    expect(r2.pendingMultipartUploads).toBe(0);
  });

  test("multipart upload can be canceled without leaving an object", async () => {
    const createRes = await router.fetch(
      makeRequest("/api/files/multipart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "canceled.bin",
          mimeType: "application/octet-stream",
          size: MULTIPART_PART_SIZE + 1,
          description: "",
          tags: "",
        }),
      }),
    );
    const session = await decodeJson(createRes, MultipartUploadResponse);

    const abortRes = await router.fetch(
      makeRequest(`/api/files/multipart/${session.fileId}`, {
        method: "DELETE",
        headers: { "x-shedflare-upload-id": session.uploadId },
      }),
    );

    expect(abortRes.status).toBe(200);
    expect(await abortRes.json()).toEqual({ ok: true });
    expect(r2.pendingMultipartUploads).toBe(0);
    expect(r2.has(`files/${session.fileId}`)).toBe(false);
  });

  test("full CRUD lifecycle", async () => {
    const form = new FormData();
    form.set("file", new File(["data"], "lifecycle.txt", { type: "text/plain" }));
    form.set("tags", "alpha,beta");

    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    expect(createRes.status).toBe(201);
    const { file } = await decodeJson(createRes, FileResponse);
    expect(file.tags).toHaveLength(2);

    const listRes = await router.fetch(makeRequest("/api/files"));
    const { files } = await decodeJson(listRes, FilesResponse);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(file.id);

    const updateRes = await router.fetch(
      makeRequest(`/api/files/${file.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed.txt", isPublic: true }),
      }),
    );
    expect(updateRes.status).toBe(200);
    const updated = await decodeJson(updateRes, FileResponse);
    expect(updated.file.name).toBe("renamed.txt");
    expect(updated.file.isPublic).toBe(true);

    const downloadRes = await router.fetch(makeRequest(`/api/files/${file.id}/download`));
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.text()).toBe("data");

    const deleteRes = await router.fetch(
      makeRequest(`/api/files/${file.id}`, { method: "DELETE" }),
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = await decodeJson(deleteRes, DeleteResponse);
    expect(deleteBody.ok).toBe(true);

    const afterDelete = await router.fetch(makeRequest("/api/files"));
    const { files: remaining } = await decodeJson(afterDelete, FilesResponse);
    expect(remaining).toHaveLength(0);
  });

  test("GET /api/files/:id/download returns 404 for missing file", async () => {
    const res = await router.fetch(makeRequest("/api/files/nonexistent/download"));
    expect(res.status).toBe(404);
  });

  test("GET /api/files/:id/preview streams requested byte ranges", async () => {
    const form = new FormData();
    form.set("file", new File(["0123456789"], "clip.mp4", { type: "video/mp4" }));
    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    const { file } = await decodeJson(createRes, FileResponse);

    const previewRes = await router.fetch(
      makeRequest(`/api/files/${file.id}/preview`, {
        headers: { range: "bytes=2-5" },
      }),
    );

    expect(previewRes.status).toBe(206);
    expect(previewRes.headers.get("accept-ranges")).toBe("bytes");
    expect(previewRes.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(previewRes.headers.get("content-length")).toBe("4");
    expect(await previewRes.text()).toBe("2345");
  });

  test("GET /api/files/:id/preview rejects unsatisfiable byte ranges", async () => {
    const form = new FormData();
    form.set("file", new File(["short"], "clip.mp4", { type: "video/mp4" }));
    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    const { file } = await decodeJson(createRes, FileResponse);

    const previewRes = await router.fetch(
      makeRequest(`/api/files/${file.id}/preview`, {
        headers: { range: "bytes=99-" },
      }),
    );

    expect(previewRes.status).toBe(416);
    expect(previewRes.headers.get("content-range")).toBe("bytes */5");
  });

  test("PATCH /api/files/:id returns 404 for missing file", async () => {
    const res = await router.fetch(
      makeRequest("/api/files/nonexistent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "nope" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("PATCH /api/files/:id returns 400 for invalid body", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "f.txt", { type: "text/plain" }));
    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    const { file } = await decodeJson(createRes, FileResponse);

    const res = await router.fetch(
      makeRequest(`/api/files/${file.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 42 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("DELETE /api/files/:id returns 404 for missing file", async () => {
    const res = await router.fetch(makeRequest("/api/files/nonexistent", { method: "DELETE" }));
    expect(res.status).toBe(404);
  });

  test("GET /api/files with pagination", async () => {
    for (let i = 0; i < 3; i++) {
      const form = new FormData();
      form.set("file", new File([`content ${i}`], `file-${i}.txt`, { type: "text/plain" }));
      await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    }

    const res = await router.fetch(makeRequest("/api/files?limit=2&offset=0"));
    const body = await decodeJson(res, FilesResponse);
    expect(body.files).toHaveLength(2);
    expect(body.nextOffset).toBe(2);

    const page2 = await router.fetch(makeRequest("/api/files?limit=2&offset=2"));
    const body2 = await decodeJson(page2, FilesResponse);
    expect(body2.files).toHaveLength(1);
    expect(body2.nextOffset).toBeNull();
  });
});

describe("secure upload commands", () => {
  let db: D1Shim;
  let r2: R2Mock;
  let env: ReturnType<typeof makeTestEnv>;
  let router: ReturnType<typeof createRouter>;

  beforeEach(() => {
    db = createTestD1();
    r2 = new R2Mock();
    env = makeTestEnv(db, r2);
    router = createRouter(env);
  });

  async function createCommand() {
    const response = await router.fetch(
      makeRequest("/api/secure-uploads/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresInSeconds: 120 }),
      }),
    );
    expect(response.status).toBe(200);
    return decodeJson(response, SecureUploadCommandResponse);
  }

  test("creates a two-minute command with one file path placeholder", async () => {
    const before = Date.now();
    const result = await createCommand();
    const expiry = new Date(result.expiresAt).getTime();

    expect(result.command).toContain("bash -o pipefail -c");
    expect(result.command).toContain("'http://localhost/api/secure-uploads/client/");
    expect(result.command).toContain("| bash -s --");
    expect(result.command).not.toContain("python");
    expect(result.command).toContain('"<path-to-file>"');
    expect(result.command.match(/<path-to-file>/gu)).toHaveLength(1);
    expect(result.maxBytes).toBe(SECURE_UPLOAD_MAX_BYTES);
    expect(expiry).toBeGreaterThanOrEqual(before + 119_000);
    expect(expiry).toBeLessThanOrEqual(before + 121_000);
  });

  test("secure command performs a multipart upload without an authenticated session", async () => {
    const { command } = await createCommand();
    const clientUrl = command.match(/-- '([^']+)'/u)?.[1];
    expect(clientUrl).toBeTruthy();
    const clientPath = new URL(clientUrl ?? "http://localhost").pathname;
    const clientResponse = await router.fetch(makeRequest(clientPath));
    expect(clientResponse.status).toBe(200);
    const script = await clientResponse.text();
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("max_bytes=524288000");
    expect(script).not.toContain("python");
    const syntaxCheck = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(syntaxCheck.stderr).toBe("");
    expect(syntaxCheck.status).toBe(0);

    const startToken = clientPath.match(/^\/api\/secure-uploads\/client\/(.+)\.sh$/u)?.[1];
    expect(startToken).toBeTruthy();
    const bytes = new TextEncoder().encode("uploaded from a secure command");
    const startBody = new URLSearchParams({
      name: "remote.txt",
      mimeType: "text/plain",
      size: String(bytes.byteLength),
    });
    const startResponse = await router.fetch(
      makeRequest(`/api/secure-uploads/start/${startToken}`, {
        method: "POST",
        headers: { accept: "text/plain" },
        body: startBody,
      }),
    );
    expect(startResponse.status).toBe(201);
    const [sessionToken, partSize] = (await startResponse.text()).trim().split("\t");
    expect(Number(partSize)).toBe(SECURE_UPLOAD_PART_SIZE);

    const partResponse = await router.fetch(
      makeRequest(`/api/secure-uploads/session/${sessionToken}/parts/1`, {
        method: "PUT",
        headers: { accept: "text/plain", "content-length": String(bytes.byteLength) },
        body: bytes,
      }),
    );
    expect(partResponse.status).toBe(200);
    const etag = (await partResponse.text()).trim();

    const completeBody = new URLSearchParams({
      name: "remote.txt",
      mimeType: "text/plain",
      size: String(bytes.byteLength),
      partNumber: "1",
      etag,
    });
    const completeResponse = await router.fetch(
      makeRequest(`/api/secure-uploads/session/${sessionToken}/complete`, {
        method: "POST",
        headers: { accept: "text/plain" },
        body: completeBody,
      }),
    );
    expect(completeResponse.status).toBe(201);
    expect(await completeResponse.text()).toBe("ok\n");
    const listResponse = await router.fetch(makeRequest("/api/files"));
    const listed = await decodeJson(listResponse, FilesResponse);
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]).toMatchObject({
      name: "remote.txt",
      size: bytes.byteLength,
      isPublic: false,
    });
    expect(r2.has(`files/${listed.files[0]?.id}`)).toBe(true);
    expect(r2.pendingMultipartUploads).toBe(0);
  });

  test("consumes a start capability exactly once", async () => {
    const { command } = await createCommand();
    const clientUrl = command.match(/-- '([^']+)'/u)?.[1] ?? "";
    const startToken = new URL(clientUrl).pathname.match(
      /^\/api\/secure-uploads\/client\/(.+)\.sh$/u,
    )?.[1];
    const startRequest = () =>
      makeRequest(`/api/secure-uploads/start/${startToken}`, {
        method: "POST",
        body: new URLSearchParams({
          name: "single-use.txt",
          mimeType: "text/plain",
          size: "4",
        }),
      });

    const first = await router.fetch(startRequest());
    expect(first.status).toBe(201);
    const session = await decodeJson(first, SecureUploadSessionResponse);

    const replay = await router.fetch(startRequest());
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "upload_token_already_used" });
    expect(r2.pendingMultipartUploads).toBe(1);

    const abort = await router.fetch(
      makeRequest(`/api/secure-uploads/session/${session.sessionToken}`, { method: "DELETE" }),
    );
    expect(abort.status).toBe(200);
    expect(r2.pendingMultipartUploads).toBe(0);
  });

  test("cleans up tracked expired multipart sessions", async () => {
    const upload = await r2.createMultipartUpload("files/expired-file");
    await drizzle(env.DB)
      .insert(secureUploadSessions)
      .values({
        uploadId: upload.uploadId,
        fileId: "expired-file",
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 10_000,
      });

    await createCommand();

    expect(r2.pendingMultipartUploads).toBe(0);
    const remaining = await drizzle(env.DB)
      .select()
      .from(secureUploadSessions)
      .where(eq(secureUploadSessions.uploadId, upload.uploadId));
    expect(remaining).toEqual([]);
  });

  test("rejects files larger than 500 MB before creating an R2 upload", async () => {
    const { command } = await createCommand();
    const clientUrl = command.match(/-- '([^']+)'/u)?.[1] ?? "";
    const startToken = new URL(clientUrl).pathname.match(
      /^\/api\/secure-uploads\/client\/(.+)\.sh$/u,
    )?.[1];
    const response = await router.fetch(
      makeRequest(`/api/secure-uploads/start/${startToken}`, {
        method: "POST",
        body: new URLSearchParams({
          name: "too-large.bin",
          mimeType: "application/octet-stream",
          size: String(SECURE_UPLOAD_MAX_BYTES + 1),
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(r2.pendingMultipartUploads).toBe(0);
  });

  test("rejects expired and tampered start capabilities", async () => {
    const expired = await signSecureUploadCapability(env, {
      kind: "secure-upload-start",
      expiresAt: Date.now() - 1,
      maxBytes: SECURE_UPLOAD_MAX_BYTES,
      nonce: crypto.randomUUID(),
    });
    const expiredResponse = await router.fetch(
      makeRequest(`/api/secure-uploads/client/${expired}.sh`),
    );
    expect(expiredResponse.status).toBe(401);

    const { command } = await createCommand();
    const clientUrl = command.match(/-- '([^']+)'/u)?.[1] ?? "";
    const tamperedUrl = new URL(clientUrl);
    const token =
      tamperedUrl.pathname.match(/^\/api\/secure-uploads\/client\/(.+)\.sh$/u)?.[1] ?? "";
    const [payload, signature = ""] = token.split(".");
    const replacement = signature.startsWith("a") ? "b" : "a";
    tamperedUrl.pathname = `/api/secure-uploads/client/${payload}.${replacement}${signature.slice(1)}.sh`;
    const tamperedResponse = await router.fetch(makeRequest(tamperedUrl.pathname));
    expect(tamperedResponse.status).toBe(401);
  });

  test("requires the Drive session to create commands", async () => {
    const { DEV_AUTH_EMAIL: _devAuthEmail, ...unauthenticatedEnv } = makeTestEnv(
      createTestD1(),
      new R2Mock(),
    );
    const unauthenticatedRouter = createRouter(unauthenticatedEnv);
    const response = await unauthenticatedRouter.fetch(
      makeRequest("/api/secure-uploads/command", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("tags API", () => {
  let db: D1Shim;
  let r2: R2Mock;
  let router: ReturnType<typeof createRouter>;

  beforeEach(() => {
    db = createTestD1();
    r2 = new R2Mock();
    router = createRouter(makeTestEnv(db, r2));
  });

  test("GET /api/tags returns empty list", async () => {
    const res = await router.fetch(makeRequest("/api/tags"));
    expect(res.status).toBe(200);
    const body = await decodeJson(res, TagsResponse);
    expect(body.tags).toEqual([]);
  });

  test("GET /api/tags returns tags from uploaded files", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "f.txt", { type: "text/plain" }));
    form.set("tags", "work,personal");
    await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));

    const res = await router.fetch(makeRequest("/api/tags"));
    const body = await decodeJson(res, TagsResponse);
    expect(body.tags).toHaveLength(2);
    const names = body.tags.map((t) => t.name).sort();
    expect(names).toEqual(["personal", "work"]);
  });
});

describe("public file routes", () => {
  let db: D1Shim;
  let r2: R2Mock;
  let router: ReturnType<typeof createRouter>;

  beforeEach(() => {
    db = createTestD1();
    r2 = new R2Mock();
    router = createRouter(makeTestEnv(db, r2));
  });

  test("public file download works after publishing", async () => {
    const form = new FormData();
    form.set("file", new File(["public content"], "pub.txt", { type: "text/plain" }));
    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    const { file } = await decodeJson(createRes, FileResponse);

    await router.fetch(
      makeRequest(`/api/files/${file.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      }),
    );

    const pubRes = await router.fetch(makeRequest(`/public/files/${file.id}/download`));
    expect(pubRes.status).toBe(200);
    expect(await pubRes.text()).toBe("public content");
  });

  test("public previews support byte ranges", async () => {
    const form = new FormData();
    form.set("file", new File(["public video"], "public.mp4", { type: "video/mp4" }));
    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    const { file } = await decodeJson(createRes, FileResponse);
    await router.fetch(
      makeRequest(`/api/files/${file.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: true }),
      }),
    );

    const previewRes = await router.fetch(
      makeRequest(`/public/files/${file.id}/preview`, {
        headers: { range: "bytes=-5" },
      }),
    );

    expect(previewRes.status).toBe(206);
    expect(previewRes.headers.get("content-range")).toBe("bytes 7-11/12");
    expect(await previewRes.text()).toBe("video");
  });

  test("unpublished file returns 404 on public route", async () => {
    const form = new FormData();
    form.set("file", new File(["private"], "priv.txt", { type: "text/plain" }));
    const createRes = await router.fetch(makeRequest("/api/files", { method: "POST", body: form }));
    const { file } = await decodeJson(createRes, FileResponse);

    const pubRes = await router.fetch(makeRequest(`/public/files/${file.id}/download`));
    expect(pubRes.status).toBe(404);
  });
});

describe("auth enforcement", () => {
  test("unauthenticated request to /api/files returns 401", async () => {
    const db = createTestD1();
    const r2 = new R2Mock();
    const { DEV_AUTH_EMAIL: _devAuthEmail, ...env } = makeTestEnv(db, r2);
    const router = createRouter(env);

    const res = await router.fetch(makeRequest("/api/files"));
    expect(res.status).toBe(401);
  });

  test("unauthenticated request to /api/tags returns 401", async () => {
    const db = createTestD1();
    const r2 = new R2Mock();
    const { DEV_AUTH_EMAIL: _devAuthEmail, ...env } = makeTestEnv(db, r2);
    const router = createRouter(env);

    const res = await router.fetch(makeRequest("/api/tags"));
    expect(res.status).toBe(401);
  });
});
