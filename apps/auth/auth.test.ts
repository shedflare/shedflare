import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, Headers as WorkerHeaders, Response as WorkerResponse } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { readdir, readFile } from "node:fs/promises";
import { array, object, parse, string } from "valibot";
import {
  hashToken,
  randomToken,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "@shedflare/auth-client/contract";
import { DeviceAuthorizationSchema, DeviceTokenSchema } from "@shedflare/auth-client/deployments";
import { inspectDeployments } from "./src/deployments";

const owner = "owner@example.com";
const authOrigin = "https://auth.example.com";
const moneyOrigin = "https://money.example.com";
const driveOrigin = "https://drive.example.com";
let runtime: Miniflare;
let signingKey: CryptoKey;
let cloudflareMode: "success" | "unavailable" | "invalid" = "success";
const cloudflareCalls: Array<{ url: string; method: string }> = [];
const cloudflareAccount = "a".repeat(32);

async function bundle(entry: string) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "esnext",
      minify: false,
      lib: { entry, formats: ["es"], fileName: "worker" },
      rolldownOptions: { external: ["cloudflare:workers"], output: { codeSplitting: false } },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("Expected one Worker bundle");
  const chunk = output.output.find((item) => item.type === "chunk" && item.isEntry);
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing Worker bundle");
  return chunk.code;
}

beforeAll(async () => {
  const [authScript, appScript, keys] = await Promise.all([
    bundle(new URL("./src/worker.ts", import.meta.url).pathname),
    bundle(new URL("./test/app-worker.ts", import.meta.url).pathname),
    generateKeyPair("RS256", { extractable: true }),
  ]);
  signingKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "google-test-key",
    alg: "RS256",
    use: "sig",
  };
  runtime = new Miniflare({
    workers: [
      // Miniflare's external proxy rejects browser Origin headers for CSRF
      // protection. Reconstruct them inside this test-only ingress Worker.
      {
        name: "ingress",
        modules: true,
        compatibilityDate: "2026-03-22",
        serviceBindings: {
          auth: "auth",
          money: "money",
          drive: "drive",
          unavailable: "unavailable",
        },
        script: `export default { fetch(request, env) {
          const headers = new Headers(request.headers);
          const target = headers.get("x-test-worker");
          const origin = headers.get("x-test-origin");
          if (origin) headers.set("origin", origin);
          headers.delete("x-test-origin"); headers.delete("x-test-worker");
          return env[target].fetch(new Request(request, { headers }));
        } }`,
      },
      {
        name: "auth",
        // Hono loads cloudflare:workers dynamically for its runtime logger.
        // The complete bundle is one module; no dependency scan is needed.
        modules: [{ type: "ESModule", path: "auth.mjs", contents: authScript }],
        compatibilityDate: "2026-03-22",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: { OPENAUTH_STORAGE: "auth-openauth-storage" },
        d1Databases: { AUTH_DB: "auth-test-db" },
        bindings: {
          APP_PUBLIC_URL: authOrigin,
          GOOGLE_CLIENT_ID: "test-google-client",
          OWNER_EMAIL: owner,
          CLOUDFLARE_ACCOUNT_ID: cloudflareAccount,
          DEPLOYMENTS_CF_API_TOKEN: "test-cloudflare-secret",
          ALLOWED_CLIENTS: JSON.stringify({
            "shedflare-money": [moneyOrigin],
            "shedflare-drive": [driveOrigin],
          }),
        },
        outboundService: (request: { url: string; method: string }) => {
          if (request.url.startsWith("https://api.cloudflare.com/")) {
            cloudflareCalls.push({ url: request.url, method: request.method });
            if (cloudflareMode === "unavailable")
              return new WorkerResponse("Unavailable", { status: 500 });
            if (cloudflareMode === "invalid")
              return WorkerResponse.json({ success: true, result: null });
            if (request.url.endsWith("/workers/scripts"))
              return WorkerResponse.json({
                success: true,
                result: [
                  {
                    id: "shedflare-prod-drive",
                    modified_on: "2026-09-08T00:00:00Z",
                    bindings: [{ name: "SECRET", text: "must-not-leak" }],
                  },
                ],
              });
            if (request.url.endsWith("/shedflare-prod-drive/deployments"))
              return WorkerResponse.json({
                success: true,
                result: {
                  deployments: [
                    {
                      id: "test-deployment",
                      created_on: "2026-09-08T00:00:00Z",
                      source: "api",
                      strategy: "percentage",
                      versions: [{ version_id: "test-version", percentage: 100 }],
                      credentials: "must-not-leak",
                    },
                  ],
                },
              });
            return new WorkerResponse("Not found", { status: 404 });
          }
          if (request.url === "https://accounts.google.com/.well-known/openid-configuration")
            return WorkerResponse.json({
              issuer: "https://accounts.google.com",
              authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
              jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
            });
          if (request.url !== "https://www.googleapis.com/oauth2/v3/certs")
            throw new Error("Unexpected outbound request");
          return WorkerResponse.json({ keys: [jwk] });
        },
      },
      ...["money", "drive"].map((app) => ({
        name: app,
        modules: true,
        script: appScript,
        compatibilityDate: "2026-03-22",
        serviceBindings: { AUTH: "auth" },
        bindings: {
          APP_PUBLIC_URL: `https://${app}.example.com`,
          AUTH_URL: authOrigin,
          AUTH_CLIENT_ID: `shedflare-${app}`,
          OWNER_EMAIL: owner,
        },
      })),
      {
        name: "unavailable",
        modules: true,
        script: appScript,
        compatibilityDate: "2026-03-22",
        serviceBindings: { AUTH: "broken" },
        bindings: {
          APP_PUBLIC_URL: moneyOrigin,
          AUTH_URL: authOrigin,
          AUTH_CLIENT_ID: "shedflare-money",
          OWNER_EMAIL: owner,
        },
      },
      {
        name: "broken",
        modules: true,
        compatibilityDate: "2026-03-22",
        script: `import { WorkerEntrypoint } from "cloudflare:workers";
        export default class extends WorkerEntrypoint { validateSession() { throw new Error("Database unavailable"); } revokeSession() { throw new Error("Database unavailable"); } }`,
      },
    ],
  });
  const db = await runtime.getD1Database("AUTH_DB", "auth");
  const dir = new URL("./src/migrations/", import.meta.url);
  for (const migration of (await readdir(dir)).sort()) {
    const sql = await readFile(new URL(`${migration}/migration.sql`, dir), "utf8");
    await db.exec(sql.replaceAll("--> statement-breakpoint", "").replaceAll("\n", " "));
  }
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

function cookie(response: { headers: { getSetCookie(): string[] } }, name: string) {
  const value = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.split(";")[0];
}

async function fetchWorker(
  name: string,
  url: string,
  init?: Parameters<Awaited<ReturnType<Miniflare["getWorker"]>>["fetch"]>[1],
) {
  const worker = await runtime.getWorker("ingress");
  const headers = new WorkerHeaders(init?.headers);
  const origin = headers.get("origin");
  if (origin) {
    headers.set("x-test-origin", origin);
    headers.delete("origin");
  }
  headers.set("x-test-worker", name);
  return worker.fetch(url, { ...init, headers: Object.fromEntries(headers), redirect: "manual" });
}

async function startLogin(app = "money", returnTo = "/") {
  const response = await fetchWorker(
    app,
    `https://${app}.example.com/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  );
  expect(response.status).toBe(302);
  const appCookie = cookie(response, STATE_COOKIE);
  const authorize = await fetchWorker("auth", response.headers.get("location") ?? "");
  const google = new URL(authorize.headers.get("location") ?? "");
  expect(google.origin).toBe("https://accounts.google.com");
  return {
    app,
    appCookie,
    google,
    googleCookie: [
      cookie(authorize, "provider"),
      cookie(authorize, "__Host-shedflare_login_flow"),
    ].join("; "),
  };
}

async function googleCallback(
  login: Pick<Awaited<ReturnType<typeof startLogin>>, "google" | "googleCookie">,
  claims: {
    email?: string;
    email_verified?: boolean;
    nonce?: string;
    iss?: string;
    aud?: string;
    exp?: number;
  } = {},
) {
  const token = await new SignJWT({
    email: owner,
    email_verified: true,
    nonce: login.google.searchParams.get("nonce"),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
    .setSubject("google-owner")
    .setIssuer(claims.iss ?? "https://accounts.google.com")
    .setAudience(claims.aud ?? "test-google-client")
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(signingKey);
  return fetchWorker("auth", `${authOrigin}/google/callback`, {
    method: "POST",
    headers: { cookie: login.googleCookie },
    body: new URLSearchParams({
      id_token: token,
      state: login.google.searchParams.get("state") ?? "",
    }),
  });
}

async function signIn(app = "money") {
  const login = await startLogin(app, "/saved?tab=one");
  const google = await googleCallback(login);
  expect(google.status).toBe(303);
  const callback = google.headers.get("location") ?? "";
  const appResponse = await fetchWorker(app, callback, { headers: { cookie: login.appCookie } });
  expect(appResponse.status).toBe(302);
  expect(appResponse.headers.get("location")).toBe(`https://${app}.example.com/saved?tab=one`);
  return {
    appCookie: cookie(appResponse, SESSION_COOKIE),
    ssoCookie: cookie(google, "__Host-shedflare_sso"),
    callback,
    login,
  };
}

async function signInWithSso(ssoCookie: string, app = "drive") {
  const login = await fetchWorker(app, `https://${app}.example.com/api/auth/login?auto=1`);
  const auth = await fetchWorker("auth", login.headers.get("location") ?? "", {
    headers: { cookie: ssoCookie },
  });
  const response = await fetchWorker(app, auth.headers.get("location") ?? "", {
    headers: { cookie: cookie(login, STATE_COOKIE) },
  });
  expect(response.status).toBe(302);
  return cookie(response, SESSION_COOKIE);
}

async function session(appCookie: string, app = "money") {
  return fetchWorker(app, `https://${app}.example.com/api/session`, {
    headers: { cookie: appCookie },
  });
}

describe("opaque Auth sessions over native Worker RPC", () => {
  test("Google login and cross-app SSO issue opaque, scoped cookies; no credentials are stored in plaintext", async () => {
    const login = await signIn();
    const response = await session(login.appCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { email: owner } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await (await session(await signInWithSso(login.ssoCookie), "drive")).json()).toEqual({
      user: { email: owner },
    });
    expect((await session(login.appCookie, "drive")).status).toBe(401);
    const token = login.appCookie.split("=")[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const providerStorage = await runtime.getKVNamespace("OPENAUTH_STORAGE", "auth");
    expect((await providerStorage.list({ prefix: "encryption:key" })).keys.length).toBeGreaterThan(
      0,
    );
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    expect(
      await db
        .prepare("SELECT token_hash FROM app_sessions WHERE token_hash = ?")
        .bind(token)
        .first(),
    ).toBeNull();
  });

  test("app logout revokes the linked login, all app sessions, and future silent handoffs", async () => {
    const login = await signIn();
    const driveCookie = await signInWithSso(login.ssoCookie);
    const otherDevice = await signIn();
    const pending = await fetchWorker("drive", `${driveOrigin}/api/auth/login?auto=1`);
    const handoff = await fetchWorker("auth", pending.headers.get("location") ?? "", {
      headers: { cookie: login.ssoCookie },
    });
    const loggedOut = await fetchWorker("money", `${moneyOrigin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: login.appCookie, origin: moneyOrigin },
    });
    expect(loggedOut.status).toBe(303);
    expect((await session(login.appCookie)).status).toBe(401);
    expect((await session(driveCookie, "drive")).status).toBe(401);
    expect((await session(otherDevice.appCookie)).status).toBe(200);
    expect(
      (
        await fetchWorker("drive", handoff.headers.get("location") ?? "", {
          headers: { cookie: cookie(pending, STATE_COOKIE) },
        })
      ).status,
    ).toBe(400);
    const start = await fetchWorker("money", `${moneyOrigin}/api/auth/login?auto=1`);
    const silent = await fetchWorker("auth", start.headers.get("location") ?? "", {
      headers: { cookie: login.ssoCookie },
    });
    expect(new URL(silent.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "no_session",
    );
  });

  test("Auth logout revokes existing app cookies", async () => {
    const login = await signIn();
    const result = await fetchWorker("auth", `${authOrigin}/logout`, {
      method: "POST",
      headers: { cookie: login.ssoCookie, origin: authOrigin },
    });
    expect(result.status).toBe(303);
    expect((await session(login.appCookie)).status).toBe(401);
  });

  test("expired parent sessions cannot authenticate or produce new app sessions", async () => {
    const login = await signIn();
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db.prepare("UPDATE login_sessions SET expires_at = 0").run();
    expect((await session(login.appCookie)).status).toBe(401);
  });

  test("callbacks reject absent/mismatched state without consuming a valid code, and codes cannot replay", async () => {
    const login = await startLogin();
    const google = await googleCallback(login);
    const callback = google.headers.get("location") ?? "";
    expect((await fetchWorker("money", callback)).status).toBe(400);
    const tampered = new URL(callback);
    tampered.searchParams.set("state", randomToken());
    expect(
      (await fetchWorker("money", tampered.toString(), { headers: { cookie: login.appCookie } }))
        .status,
    ).toBe(400);
    const valid = await fetchWorker("money", callback, { headers: { cookie: login.appCookie } });
    expect(valid.status).toBe(302);
    expect(
      (await fetchWorker("money", callback, { headers: { cookie: login.appCookie } })).status,
    ).toBe(400);
  });

  test("one simultaneous handoff exchange succeeds; wrong verifier/client/origin cannot consume it", async () => {
    const login = await startLogin();
    const google = await googleCallback(login);
    const callback = new URL(google.headers.get("location") ?? "");
    const state = parse(
      object({ verifier: string() }),
      JSON.parse(decodeURIComponent(login.appCookie.slice(login.appCookie.indexOf("=") + 1))),
    );
    const input = {
      clientId: "shedflare-money",
      origin: moneyOrigin,
      code: callback.searchParams.get("code"),
      verifier: state.verifier,
    };
    const exchange = async (body: typeof input) =>
      (
        await fetchWorker("money", `${moneyOrigin}/test/exchange`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).json();
    expect(await exchange({ ...input, verifier: randomToken() })).toEqual({ kind: "invalid" });
    expect(await exchange({ ...input, clientId: "shedflare-drive", origin: driveOrigin })).toEqual({
      kind: "invalid",
    });
    expect(await exchange({ ...input, origin: "https://evil.example" })).toEqual({
      kind: "invalid",
    });
    const results = await Promise.all([exchange(input), exchange(input)]);
    expect(results).toEqual(
      expect.arrayContaining([
        { kind: "invalid" },
        expect.objectContaining({ kind: "authenticated" }),
      ]),
    );
  });

  test("expired handoffs cannot be exchanged", async () => {
    const login = await startLogin();
    const google = await googleCallback(login);
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db.prepare("UPDATE handoffs SET expires_at = 0").run();
    expect(
      (
        await fetchWorker("money", google.headers.get("location") ?? "", {
          headers: { cookie: login.appCookie },
        })
      ).status,
    ).toBe(400);
  });

  test.each([
    { email: "someone@example.com" },
    { email_verified: false },
    { nonce: "wrong" },
    { iss: "https://evil.example" },
    { aud: "another-google-client" },
    { exp: 1 },
  ])("rejects invalid Google identity %j", async (claims) => {
    expect((await googleCallback(await startLogin(), claims)).status).toBe(403);
  });

  test("OpenAuth login requires browser cookies and the app login flow is single-use", async () => {
    const login = await startLogin();
    expect((await googleCallback({ ...login, googleCookie: "" })).status).toBe(400);
    expect((await googleCallback(login)).status).toBe(303);
    expect((await googleCallback(login)).status).toBe(400);
  });

  test("OpenAuth rejects a Google response paired with another browser's provider cookie", async () => {
    const login = await startLogin();
    const anotherBrowser = await startLogin();
    expect(
      (await googleCallback({ ...login, googleCookie: anotherBrowser.googleCookie })).status,
    ).toBe(403);
    expect((await googleCallback(login)).status).toBe(303);
  });

  test("expired app login flows cannot create a session after OpenAuth login", async () => {
    const login = await startLogin();
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db.prepare("UPDATE login_flows SET expires_at = 0").run();
    expect((await googleCallback(login)).status).toBe(400);
  });

  test.each([
    ["/saved?q=50%25%20off%26more", "/saved?q=50%25%20off%26more"],
    ["//evil.example", "/"],
    ["/%2Fevil.example", "/"],
    ["/\\evil.example", "/"],
  ])("login returns safely to %s", async (returnTo, expected) => {
    const login = await startLogin("money", returnTo);
    const google = await googleCallback(login);
    const response = await fetchWorker("money", google.headers.get("location") ?? "", {
      headers: { cookie: login.appCookie },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(moneyOrigin + expected);
  });

  test("all authorization paths enforce the client, exact callback, and proof", async () => {
    const start = await fetchWorker("money", `${moneyOrigin}/api/auth/login`);
    const good = new URL(start.headers.get("location") ?? "");
    for (const [key, value] of [
      ["client_id", "attacker"],
      ["redirect_uri", `${moneyOrigin}/other`],
      ["redirect_uri", "https://evil.example/api/auth/callback"],
      ["code_challenge", ""],
    ]) {
      const url = new URL(good);
      url.searchParams.set(key, value);
      const result = await fetchWorker("auth", url.toString());
      expect(result.status).toBe(400);
      expect(result.headers.get("location")).toBeNull();
    }
  });

  test("silent failure returns once to the app and stops redirecting", async () => {
    const initial = await fetchWorker("money", `${moneyOrigin}/saved`, {
      headers: { accept: "text/html" },
    });
    const silent = await fetchWorker("auth", initial.headers.get("location") ?? "");
    const callback = await fetchWorker("money", silent.headers.get("location") ?? "", {
      headers: { cookie: cookie(initial, STATE_COOKIE) },
    });
    const page = await fetchWorker("money", callback.headers.get("location") ?? "", {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ email: null });
  });

  test("RPC failures return retryable 503s and preserve session cookies", async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${randomToken()}`, accept: "text/html" };
    for (const path of ["/api/session", "/"]) {
      const result = await fetchWorker("unavailable", moneyOrigin + path, { headers });
      expect(result.status).toBe(503);
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(result.headers.get("location")).toBeNull();
    }
    const logout = await fetchWorker("unavailable", `${moneyOrigin}/api/auth/logout`, {
      method: "POST",
      headers: { ...headers, origin: moneyOrigin },
    });
    expect(logout.status).toBe(503);
    expect(logout.headers.getSetCookie()).toEqual([]);
    expect(logout.headers.get("location")).toBeNull();
  });

  test("logout rejects cross-origin requests and retired token/JWKS routes are absent", async () => {
    const login = await signIn();
    expect(
      (
        await fetchWorker("money", `${moneyOrigin}/api/auth/logout`, {
          method: "POST",
          headers: { cookie: login.appCookie, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await session(login.appCookie)).status).toBe(200);
    for (const path of ["/token", "/.well-known/jwks.json", "/.well-known/openid-configuration"]) {
      expect((await fetchWorker("auth", authOrigin + path)).status).toBe(404);
    }
    expect((await session("auth_access_token=old; auth_refresh_token=old")).status).toBe(401);
  });
});

async function issueAgentToken(ssoCookie: string, name = "Deployment agent") {
  const response = await fetchWorker("auth", `${authOrigin}/tokens`, {
    method: "POST",
    headers: {
      cookie: ssoCookie,
      origin: authOrigin,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, days: 30 }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return parse(object({ token: string(), id: string() }), await response.json());
}

describe("read-only agent deployment tokens", () => {
  test("deployment inspection is disabled until both upstream settings are configured", async () => {
    const request = new Request(`${authOrigin}/api/deployments`);
    for (const env of [
      {},
      { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount },
      { DEPLOYMENTS_CF_API_TOKEN: "test-cloudflare-secret" },
      { CLOUDFLARE_ACCOUNT_ID: "invalid", DEPLOYMENTS_CF_API_TOKEN: "test-cloudflare-secret" },
    ]) {
      const response = await inspectDeployments(request, env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Deployment inspection is not configured." });
    }
  });

  test("owner creates a token shown once; inspection returns only allowed deployment metadata", async () => {
    const login = await signIn();
    const issued = await issueAgentToken(login.ssoCookie, "<script>agent</script>");
    expect(issued.token).toMatch(/^sf_agent_[A-Za-z0-9_-]{43}$/);
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    const rows = await db.prepare("SELECT * FROM agent_tokens WHERE id = ?").bind(issued.id).all();
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    const listing = await fetchWorker("auth", `${authOrigin}/tokens`, {
      headers: { cookie: login.ssoCookie, accept: "application/json" },
    });
    const listed = await listing.text();
    expect(listed).toContain(issued.id);
    expect(listed).not.toContain(issued.token);
    expect(listed).not.toContain("tokenHash");
    const html = await fetchWorker("auth", `${authOrigin}/tokens`, {
      headers: { cookie: login.ssoCookie },
    });
    expect(html.headers.get("referrer-policy")).toBe("same-origin");
    expect(await html.text()).toContain("&lt;script&gt;agent&lt;/script&gt;");

    const before = cloudflareCalls.length;
    const headers = { authorization: `Bearer ${issued.token}` };
    const agentSession = await fetchWorker("auth", `${authOrigin}/api/agent/session`, { headers });
    expect(agentSession.status).toBe(200);
    expect(await agentSession.json()).toEqual({
      name: "<script>agent</script>",
      scope: "deployments:read",
      expiresAt: expect.any(Number),
    });
    expect(cloudflareCalls.length).toBe(before);
    expect(agentSession.headers.get("cache-control")).toBe("no-store");
    expect(agentSession.headers.get("referrer-policy")).toBe("no-referrer");
    const workers = await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers });
    expect(workers.status).toBe(200);
    expect(await workers.json()).toEqual({
      workers: [{ id: "shedflare-prod-drive", modified_on: "2026-09-08T00:00:00Z" }],
    });
    const history = await fetchWorker(
      "auth",
      `${authOrigin}/api/deployments?worker=shedflare-prod-drive`,
      { headers },
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({
      worker: "shedflare-prod-drive",
      deployments: [
        {
          id: "test-deployment",
          created_on: "2026-09-08T00:00:00Z",
          source: "api",
          strategy: "percentage",
          versions: [{ version_id: "test-version", percentage: 100 }],
        },
      ],
    });
    expect(cloudflareCalls.slice(before)).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/scripts`,
        method: "GET",
      },
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/scripts/shedflare-prod-drive/deployments`,
        method: "GET",
      },
    ]);
    const used = await db
      .prepare("SELECT last_used_at FROM agent_tokens WHERE id = ?")
      .bind(issued.id)
      .first();
    expect(used?.last_used_at).toBeGreaterThan(0);
  });

  test("absent, forged, expired, wrong-owner and revoked tokens fail without calling Cloudflare", async () => {
    const login = await signIn();
    const issued = await issueAgentToken(login.ssoCookie);
    const before = cloudflareCalls.length;
    for (const authorization of [
      "",
      `Bearer sf_agent_${randomToken()}`,
      `Bearer ${issued.token}extra`,
      `Basic ${issued.token}`,
    ]) {
      const response = await fetchWorker("auth", `${authOrigin}/api/deployments`, {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db.prepare("UPDATE agent_tokens SET expires_at = 0 WHERE id = ?").bind(issued.id).run();
    const headers = { authorization: `Bearer ${issued.token}` };
    expect((await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers })).status).toBe(
      401,
    );
    expect((await fetchWorker("auth", `${authOrigin}/api/agent/session`, { headers })).status).toBe(
      401,
    );
    await db
      .prepare("UPDATE agent_tokens SET expires_at = ?, email = ? WHERE id = ?")
      .bind(Date.now() + 60_000, "other@example.com", issued.id)
      .run();
    expect((await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers })).status).toBe(
      401,
    );
    await db.prepare("UPDATE agent_tokens SET email = ? WHERE id = ?").bind(owner, issued.id).run();
    const revoked = await fetchWorker("auth", `${authOrigin}/tokens/${issued.id}/revoke`, {
      method: "POST",
      headers: { cookie: login.ssoCookie, origin: authOrigin },
    });
    expect(revoked.status).toBe(303);
    expect((await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers })).status).toBe(
      401,
    );
    expect(cloudflareCalls.length).toBe(before);
  });

  test("tokens cannot manage credentials, authenticate app sessions, or perform writes; logout leaves tokens valid", async () => {
    const login = await signIn();
    const issued = await issueAgentToken(login.ssoCookie);
    const headers = { authorization: `Bearer ${issued.token}` };
    expect(
      (
        await fetchWorker("auth", `${authOrigin}/tokens`, {
          headers: { ...headers, cookie: login.ssoCookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchWorker("auth", `${authOrigin}/tokens`, {
          method: "POST",
          headers: { ...headers, origin: authOrigin },
          body: "name=agent&days=30",
        })
      ).status,
    ).toBe(403);
    expect((await fetchWorker("money", `${moneyOrigin}/api/session`, { headers })).status).toBe(
      401,
    );
    expect((await session(`${SESSION_COOKIE}=${issued.token}`)).status).toBe(401);
    const before = cloudflareCalls.length;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetchWorker("auth", `${authOrigin}/api/deployments`, {
        method,
        headers,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(
        (await fetchWorker("auth", `${authOrigin}/api/agent/session`, { method, headers })).status,
      ).toBe(405);
    }
    expect(
      (await fetchWorker("auth", `${authOrigin}/api/deployments?worker=..%2Fsecrets`, { headers }))
        .status,
    ).toBe(400);
    expect(cloudflareCalls.length).toBe(before);
    expect(
      (
        await fetchWorker("auth", `${authOrigin}/logout`, {
          method: "POST",
          headers: { cookie: login.ssoCookie, origin: authOrigin },
        })
      ).status,
    ).toBe(303);
    expect(
      (await fetchWorker("auth", `${authOrigin}/tokens`, { headers: { cookie: login.ssoCookie } }))
        .status,
    ).toBe(401);
    expect((await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers })).status).toBe(
      200,
    );
  });

  test("management requires a live browser login and same-origin POST; input size and expiry are bounded", async () => {
    expect((await fetchWorker("auth", `${authOrigin}/tokens`)).status).toBe(401);
    const login = await signIn();
    const headers = {
      cookie: login.ssoCookie,
      origin: authOrigin,
      "content-type": "application/json",
    };
    expect(
      (
        await fetchWorker("auth", `${authOrigin}/tokens`, {
          method: "POST",
          headers: { ...headers, origin: "https://evil.example" },
          body: JSON.stringify({ name: "agent", days: 30 }),
        })
      ).status,
    ).toBe(403);
    for (const input of [
      { name: "", days: 30 },
      { name: "agent", days: 0 },
      { name: "agent", days: 91 },
      { name: "agent", days: 1.5 },
      { name: "x".repeat(5000), days: 30 },
    ]) {
      expect(
        (
          await fetchWorker("auth", `${authOrigin}/tokens`, {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(400);
    }
    const created = await fetchWorker("auth", `${authOrigin}/tokens`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: "name=Browser+agent&days=1",
    });
    expect(created.status).toBe(201);
    expect(await created.text()).toContain("Copy this token now");
  });

  test("upstream failures and invalid responses are retryable, do not leak details, and preserve tokens", async () => {
    const login = await signIn();
    const issued = await issueAgentToken(login.ssoCookie);
    const headers = { authorization: `Bearer ${issued.token}` };
    try {
      for (const mode of ["unavailable", "invalid"] as const) {
        cloudflareMode = mode;
        const response = await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers });
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(await response.text()).not.toContain("test-cloudflare-secret");
        expect(response.headers.getSetCookie()).toEqual([]);
      }
    } finally {
      cloudflareMode = "success";
    }
    expect((await fetchWorker("auth", `${authOrigin}/api/deployments`, { headers })).status).toBe(
      200,
    );
    expect(
      (await fetchWorker("auth", `${authOrigin}/api/deployments?worker=missing`, { headers }))
        .status,
    ).toBe(404);
  });
});

async function startAgent(name = "Codex on laptop", requester = crypto.randomUUID()) {
  const response = await fetchWorker("auth", `${authOrigin}/api/agent/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": requester },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return parse(DeviceAuthorizationSchema, await response.json());
}

async function readyPoll(deviceCode: string) {
  const db = await runtime.getD1Database("AUTH_DB", "auth");
  await db
    .prepare("UPDATE agent_authorizations SET next_poll_at = 0 WHERE device_code_hash = ?")
    .bind(await hashToken(deviceCode))
    .run();
}

async function pollAgent(deviceCode: string) {
  return fetchWorker("auth", `${authOrigin}/api/agent/device/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
}

async function approveAgent(input: {
  userCode: string;
  ssoCookie: string;
  decision?: string;
  days?: number;
  origin?: string;
}) {
  return fetchWorker("auth", `${authOrigin}/agent/authorize`, {
    method: "POST",
    headers: { cookie: input.ssoCookie, origin: input.origin ?? authOrigin },
    body: new URLSearchParams({
      userCode: input.userCode,
      decision: input.decision ?? "approve",
      days: String(input.days ?? 30),
    }),
  });
}

describe("browser-approved CLI login", () => {
  test("existing owner approves access; only the polling CLI receives a usable token", async () => {
    const login = await signIn();
    const grant = await startAgent("<script>Codex</script>");
    expect(grant.verificationUriComplete).toBe(
      `${authOrigin}/agent/authorize?user_code=${grant.userCode}`,
    );
    const page = await fetchWorker("auth", grant.verificationUriComplete, {
      headers: { cookie: login.ssoCookie },
    });
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const html = await page.text();
    expect(html).toContain("&lt;script&gt;Codex&lt;/script&gt;");
    expect(html).toContain(grant.userCode);
    expect(html).toContain("Approve");
    expect(html).not.toContain(grant.deviceCode);
    await readyPoll(grant.deviceCode);
    expect(await (await pollAgent(grant.deviceCode)).json()).toEqual({
      error: "authorization_pending",
    });
    expect(
      (await approveAgent({ userCode: grant.userCode, ssoCookie: login.ssoCookie, days: 7 }))
        .status,
    ).toBe(303);
    const waiting = await fetchWorker("auth", grant.verificationUriComplete, {
      headers: { cookie: login.ssoCookie },
    });
    const waitingHtml = await waiting.text();
    expect(waitingHtml).toContain("Connecting your agent");
    expect(waitingHtml).toContain('<meta http-equiv="refresh" content="2"');
    expect(waitingHtml).not.toContain('href="/tokens"');
    await readyPoll(grant.deviceCode);
    const response = await pollAgent(grant.deviceCode);
    expect(response.status).toBe(200);
    const issued = parse(DeviceTokenSchema, await response.json());
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    expect(
      (
        await fetchWorker("auth", `${authOrigin}/api/agent/session`, {
          headers: { authorization: `Bearer ${issued.token}` },
        })
      ).status,
    ).toBe(200);
    expect(await (await pollAgent(grant.deviceCode)).json()).toMatchObject({
      error: "expired_token",
    });
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    const rows = await db
      .prepare("SELECT * FROM agent_authorizations WHERE device_code_hash = ?")
      .bind(await hashToken(grant.deviceCode))
      .all();
    expect(JSON.stringify(rows)).not.toContain(grant.deviceCode);
    expect(JSON.stringify(rows)).not.toContain(grant.userCode);
    const tokens = await db
      .prepare("SELECT * FROM agent_tokens WHERE token_hash = ?")
      .bind(await hashToken(issued.token))
      .all();
    expect(JSON.stringify(tokens)).not.toContain(issued.token);
    const finished = await fetchWorker("auth", grant.verificationUriComplete, {
      headers: { cookie: login.ssoCookie },
    });
    const finishedHtml = await finished.text();
    expect(finishedHtml).toContain("Return to your terminal");
    expect(finishedHtml).toContain('href="/tokens"');
    expect(finishedHtml).not.toContain('http-equiv="refresh"');
    const managed = await fetchWorker("auth", `${authOrigin}/tokens`, {
      headers: { cookie: login.ssoCookie, accept: "application/json" },
    });
    const access = object({ tokens: array(object({ name: string() })) });
    expect(
      parse(access, await managed.json()).tokens.some((token) => token.name === issued.name),
    ).toBe(true);
  });

  test("signed-out browser signs in with Google and returns to approval without granting access", async () => {
    const grant = await startAgent();
    const redirect = await fetchWorker("auth", grant.verificationUriComplete);
    const google = new URL(redirect.headers.get("location") ?? "");
    expect(google.origin).toBe("https://accounts.google.com");
    const googleCookie = [
      cookie(redirect, "provider"),
      cookie(redirect, "__Host-shedflare_login_flow"),
    ].join("; ");
    expect(
      (await googleCallback({ google, googleCookie }, { email: "attacker@example.com" })).status,
    ).toBe(403);
    const ownerResponse = await googleCallback({ google, googleCookie });
    expect(ownerResponse.status).toBe(303);
    expect(ownerResponse.headers.get("location")).toBe(grant.verificationUriComplete);
    expect((await googleCallback({ google, googleCookie })).status).toBe(400);
    const approval = await fetchWorker("auth", grant.verificationUriComplete, {
      headers: { cookie: cookie(ownerResponse, "__Host-shedflare_sso") },
    });
    expect(await approval.text()).toContain("Approve");
    await readyPoll(grant.deviceCode);
    expect(await (await pollAgent(grant.deviceCode)).json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  test("approval requires a current owner session, same-origin POST, and valid expiry", async () => {
    const login = await signIn();
    const grant = await startAgent();
    expect((await approveAgent({ userCode: grant.userCode, ssoCookie: "" })).status).toBe(401);
    for (const origin of ["https://evil.example", "null"])
      expect(
        (
          await approveAgent({
            userCode: grant.userCode,
            ssoCookie: login.ssoCookie,
            origin,
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await fetchWorker("auth", `${authOrigin}/agent/authorize`, {
          method: "POST",
          headers: { cookie: login.ssoCookie },
          body: new URLSearchParams({ userCode: grant.userCode, decision: "approve", days: "30" }),
        })
      ).status,
    ).toBe(403);
    for (const days of [0, 91, 1.5])
      expect(
        (await approveAgent({ userCode: grant.userCode, ssoCookie: login.ssoCookie, days })).status,
      ).toBe(400);
    const issued = await issueAgentToken(login.ssoCookie);
    expect(
      (
        await fetchWorker("auth", grant.verificationUriComplete, {
          headers: { cookie: login.ssoCookie, authorization: `Bearer ${issued.token}` },
        })
      ).status,
    ).toBe(403);
    await fetchWorker("auth", `${authOrigin}/logout`, {
      method: "POST",
      headers: { cookie: login.ssoCookie, origin: authOrigin },
    });
    expect(
      (await approveAgent({ userCode: grant.userCode, ssoCookie: login.ssoCookie })).status,
    ).toBe(401);
  });

  test("denial and expiry never issue credentials, and decisions cannot be replayed", async () => {
    const login = await signIn();
    const denied = await startAgent();
    expect(
      (
        await approveAgent({
          userCode: denied.userCode,
          ssoCookie: login.ssoCookie,
          decision: "deny",
        })
      ).status,
    ).toBe(303);
    expect(
      (await approveAgent({ userCode: denied.userCode, ssoCookie: login.ssoCookie })).status,
    ).toBe(409);
    expect(await (await pollAgent(denied.deviceCode)).json()).toMatchObject({
      error: "access_denied",
    });
    const expired = await startAgent();
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db
      .prepare("UPDATE agent_authorizations SET expires_at = 0 WHERE device_code_hash = ?")
      .bind(await hashToken(expired.deviceCode))
      .run();
    expect(
      (await approveAgent({ userCode: expired.userCode, ssoCookie: login.ssoCookie })).status,
    ).toBe(409);
    expect(await (await pollAgent(expired.deviceCode)).json()).toMatchObject({
      error: "expired_token",
    });
    expect(
      (
        await fetchWorker("auth", expired.verificationUriComplete, {
          headers: { cookie: login.ssoCookie },
        })
      ).status,
    ).toBe(410);
    expect(await (await pollAgent(randomToken())).json()).toMatchObject({ error: "expired_token" });
  });

  test("approval is bound to the configured owner and denial ignores invalid expiry input", async () => {
    const login = await signIn();
    const denied = await startAgent();
    expect(
      (
        await approveAgent({
          userCode: denied.userCode,
          ssoCookie: login.ssoCookie,
          decision: "deny",
          days: 0,
        })
      ).status,
    ).toBe(303);
    expect(await (await pollAgent(denied.deviceCode)).json()).toMatchObject({
      error: "access_denied",
    });
    const grant = await startAgent();
    await approveAgent({ userCode: grant.userCode, ssoCookie: login.ssoCookie });
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db
      .prepare(
        "UPDATE agent_authorizations SET email = 'other@example.com' WHERE device_code_hash = ?",
      )
      .bind(await hashToken(grant.deviceCode))
      .run();
    expect(await (await pollAgent(grant.deviceCode)).json()).toMatchObject({
      error: "expired_token",
    });
    expect(
      (
        await fetchWorker("auth", grant.verificationUriComplete, {
          headers: { cookie: login.ssoCookie },
        })
      ).status,
    ).toBe(410);
  });

  test("fast polls back off and simultaneous approved polls issue exactly one token", async () => {
    const login = await signIn();
    const grant = await startAgent("Concurrent device");
    expect(await (await pollAgent(grant.deviceCode)).json()).toEqual({
      error: "slow_down",
      interval: 10,
    });
    expect(await (await pollAgent(grant.deviceCode)).json()).toEqual({
      error: "slow_down",
      interval: 15,
    });
    await approveAgent({ userCode: grant.userCode, ssoCookie: login.ssoCookie });
    await readyPoll(grant.deviceCode);
    const responses = await Promise.all([pollAgent(grant.deviceCode), pollAgent(grant.deviceCode)]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    expect(
      (await db.prepare("SELECT id FROM agent_tokens WHERE name = 'Concurrent device'").all())
        .results,
    ).toHaveLength(1);
  });

  test("failed token insertion rolls back consumption and can be retried", async () => {
    const login = await signIn();
    const grant = await startAgent("Rollback device");
    await approveAgent({ userCode: grant.userCode, ssoCookie: login.ssoCookie });
    const db = await runtime.getD1Database("AUTH_DB", "auth");
    await db.exec(
      "CREATE TRIGGER fail_device_insert BEFORE INSERT ON agent_tokens WHEN NEW.name = 'Rollback device' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    try {
      await readyPoll(grant.deviceCode);
      expect((await pollAgent(grant.deviceCode)).status).toBe(503);
      expect(
        (
          await db
            .prepare("SELECT status FROM agent_authorizations WHERE device_code_hash = ?")
            .bind(await hashToken(grant.deviceCode))
            .first()
        )?.status,
      ).toBe("approved");
    } finally {
      await db.exec("DROP TRIGGER fail_device_insert");
    }
    await readyPoll(grant.deviceCode);
    expect((await pollAgent(grant.deviceCode)).status).toBe(200);
  });

  test("start enforces an atomic request budget, JSON boundaries and method checks", async () => {
    const requester = crypto.randomUUID();
    for (let i = 0; i < 9; i++) await startAgent("Budget agent", requester);
    const responses = await Promise.all(
      [0, 1].map(() =>
        fetchWorker("auth", `${authOrigin}/api/agent/device/start`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": requester },
          body: JSON.stringify({ name: "Budget agent" }),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 429]);
    for (const path of ["start", "poll"]) {
      expect((await fetchWorker("auth", `${authOrigin}/api/agent/device/${path}`)).status).toBe(
        405,
      );
      expect(
        (
          await fetchWorker("auth", `${authOrigin}/api/agent/device/${path}`, {
            method: "POST",
            body: "name=evil",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetchWorker("auth", `${authOrigin}/api/agent/device/${path}`, {
            method: "POST",
            headers: { origin: "https://evil.example", "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetchWorker("auth", `${authOrigin}/api/agent/device/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "x".repeat(5000), deviceCode: "bad" }),
          })
        ).status,
      ).toBe(400);
    }
  });
});
