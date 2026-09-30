import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { number, object, parse } from "valibot";

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const register = import.meta.resolve("jiti/register");
const token = `sf_agent_${"a".repeat(43)}`;
const session = { name: "CLI agent", scope: "deployments:read", expiresAt: 2_000_000_000_000 };
let directory: string;
let server: Server;
let authUrl: string;
let configFile: string;
let mode: "success" | "revoked" | "unavailable" | "invalid" | "redirect";
let calls: Array<{ url: string; method: string; authorization: string | undefined }>;
let deviceMode:
  | "approved"
  | "denied"
  | "expired"
  | "slow"
  | "unavailable"
  | "foreign"
  | "pending"
  | null;
let polls: number;
const deviceCode = "b".repeat(43);
const userCode = "ABCD-EFGH-JKLM";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "shedflare-agent-cli-"));
  await mkdir(join(directory, "work"));
  configFile = join(directory, "config", "shedflare", "agent.json");
  calls = [];
  mode = "success";
  deviceMode = null;
  polls = 0;
  // A real HTTP server exercises the CLI's transport and process boundary. Auth's
  // independent Miniflare suite verifies issuance, D1 expiry and revocation.
  server = createServer((request, response) => {
    calls.push({
      url: request.url ?? "",
      method: request.method ?? "",
      authorization: request.headers.authorization,
    });
    if (deviceMode && request.url?.startsWith("/api/agent/device/")) {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/agent/device/start") {
        response.end(
          JSON.stringify({
            deviceCode,
            userCode,
            verificationUri: `${authUrl}/agent/authorize`,
            verificationUriComplete: `${deviceMode === "foreign" ? "https://evil.example" : authUrl}/agent/authorize?user_code=${userCode}`,
            expiresIn: deviceMode === "pending" ? 3 : 30,
            interval: 1,
          }),
        );
        return;
      }
      polls++;
      if (deviceMode === "unavailable" && polls === 1) {
        response.writeHead(503).end(token);
        return;
      }
      if (deviceMode === "slow" && polls === 1) {
        response.writeHead(400).end(JSON.stringify({ error: "slow_down", interval: 6 }));
        return;
      }
      if (deviceMode === "denied" || deviceMode === "expired") {
        response
          .writeHead(400)
          .end(
            JSON.stringify({ error: deviceMode === "denied" ? "access_denied" : "expired_token" }),
          );
        return;
      }
      if (deviceMode === "pending" || polls === 1) {
        response.writeHead(400).end(JSON.stringify({ error: "authorization_pending" }));
        return;
      }
      response.end(JSON.stringify({ token, ...session, unexpectedSecret: token }));
      return;
    }
    if (mode === "redirect") {
      response.writeHead(302, { location: `${authUrl}/redirect-target` }).end();
      return;
    }
    if (mode === "revoked" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(token);
      return;
    }
    if (mode === "unavailable") {
      response.writeHead(503).end(token);
      return;
    }
    response.setHeader("content-type", "application/json");
    if (mode === "invalid") {
      response.end(JSON.stringify({ token }));
      return;
    }
    if (request.url === "/api/agent/session") response.end(JSON.stringify({ ...session, token }));
    else if (request.url === "/api/deployments")
      response.end(
        JSON.stringify({
          workers: [
            { id: "shedflare-prod-drive", modified_on: "2026-09-08T00:00:00Z", secret: token },
          ],
        }),
      );
    else if (request.url === "/api/deployments?worker=shedflare-prod-drive")
      response.end(
        JSON.stringify({
          worker: "shedflare-prod-drive",
          deployments: [
            {
              id: "deployment",
              created_on: "2026-09-08T00:00:00Z",
              versions: [{ version_id: "version", percentage: 100 }],
              token,
            },
          ],
        }),
      );
    else response.writeHead(404).end(token);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = parse(object({ port: number() }), server.address());
  authUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
});

async function cli(
  args: string[],
  input = "",
  onProgress?: (child: ChildProcess, progress: string) => void,
) {
  const child = spawn(process.execPath, ["--import", register, entry, ...args], {
    cwd: join(directory, "work"),
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    onProgress?.(child, stderr);
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(stdout + stderr).not.toContain(token);
  expect(stdout + stderr).not.toContain(deviceCode);
  return {
    code,
    stdout,
    stderr,
    json: stdout && args.includes("--json") ? JSON.parse(stdout) : null,
  };
}

async function login() {
  return cli(["auth", "login", "--auth-url", authUrl, "--token-stdin", "--json"], `${token}\n`);
}

describe("agent CLI through real processes", () => {
  test("logs in outside a workspace, stores private credentials and filters JSON metadata", async () => {
    expect(await login()).toMatchObject({
      code: 0,
      stderr: "",
      json: { authenticated: true, authUrl, ...session },
    });
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ authUrl, token });
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "config", "shedflare"))).mode & 0o777).toBe(0o700);
    expect((await cli(["auth", "status", "--json"])).json).toEqual({
      authenticated: true,
      authUrl,
      ...session,
    });
    expect((await cli(["deployments", "list", "--json"])).json).toEqual({
      workers: [{ id: "shedflare-prod-drive", modified_on: "2026-09-08T00:00:00Z" }],
    });
    expect((await cli(["deployments", "history", "shedflare-prod-drive", "--json"])).json).toEqual({
      worker: "shedflare-prod-drive",
      deployments: [
        {
          id: "deployment",
          created_on: "2026-09-08T00:00:00Z",
          versions: [{ version_id: "version", percentage: 100 }],
        },
      ],
    });
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/agent/session",
      "/api/agent/session",
      "/api/deployments",
      "/api/deployments?worker=shedflare-prod-drive",
    ]);
    expect(
      calls.every(
        ({ method, authorization }) => method === "GET" && authorization === `Bearer ${token}`,
      ),
    ).toBe(true);
  }, 15_000);

  test("reports missing credentials and logout removes only the local copy", async () => {
    expect(await cli(["auth", "status", "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "not_logged_in" } },
    });
    expect((await login()).code).toBe(0);
    const before = calls.length;
    expect(await cli(["auth", "logout", "--json"])).toMatchObject({
      code: 0,
      json: { loggedOut: true },
    });
    expect(calls.length).toBe(before);
    await expect(stat(configFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await login()).code).toBe(0);
  }, 15_000);

  test("detects revoked tokens; failed login and upstream failures preserve stored credentials", async () => {
    await login();
    const previous = await readFile(configFile, "utf8");
    mode = "revoked";
    expect(await cli(["auth", "status", "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "invalid_token" } },
    });
    expect(await login()).toMatchObject({ code: 1, json: { error: { code: "invalid_token" } } });
    expect(await readFile(configFile, "utf8")).toBe(previous);
    mode = "unavailable";
    expect(await cli(["deployments", "list", "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "service_unavailable" } },
    });
    mode = "invalid";
    expect(await cli(["deployments", "list", "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "invalid_response" } },
    });
    expect(await readFile(configFile, "utf8")).toBe(previous);
  }, 15_000);

  test("rejects redirects without forwarding credentials or overwriting login", async () => {
    await login();
    mode = "redirect";
    const before = calls.length;
    expect(await login()).toMatchObject({
      code: 1,
      json: { error: { code: "service_unavailable" } },
    });
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)?.url).toBe("/api/agent/session");
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ authUrl, token });
  });

  test("accepts token files and rejects malformed inputs without network access", async () => {
    const file = join(directory, "token");
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    expect(
      (await cli(["auth", "login", "--auth-url", authUrl, "--token-file", file, "--json"])).code,
    ).toBe(0);
    const before = calls.length;
    for (const args of [
      ["auth", "login", "--auth-url", "http://example.com", "--token-stdin", "--json"],
      ["auth", "login", "--auth-url", `${authUrl}/path`, "--token-stdin", "--json"],
      ["auth", "login", "--auth-url", authUrl, "--token-prompt", "--json"],
      ["auth", "login", "--auth-url", authUrl, "--token-stdin", "--token-file", file, "--json"],
      ["deployments", "history", "../secrets", "--json"],
      ["deployments", "history", "--json"],
      ["deployments", "list", "extra", "--json"],
      ["auth", "login", "--token", token, "--json"],
    ])
      expect((await cli(args, token)).code).toBe(1);
    expect(
      (await cli(["auth", "login", "--auth-url", authUrl, "--token-stdin", "--json"], "invalid"))
        .code,
    ).toBe(1);
    expect(calls.length).toBe(before);
  }, 15_000);

  test("does not read a symlink or a credential file with broad permissions", async () => {
    await login();
    await chmod(configFile, 0o644);
    expect(await cli(["auth", "status", "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "invalid_credentials" } },
    });
    const source = join(directory, "source");
    await writeFile(source, await readFile(configFile), { mode: 0o600 });
    await rm(configFile);
    await symlink(source, configFile);
    expect(await cli(["auth", "status", "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "invalid_credentials" } },
    });
    const before = await readFile(source, "utf8");
    expect((await login()).code).toBe(0);
    expect(await readFile(source, "utf8")).toBe(before);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
  }, 15_000);
});

describe("browser approval CLI through real processes", () => {
  test("normal login uses browser approval and readable completion output", async () => {
    deviceMode = "approved";
    const result = await cli(["auth", "login", "--auth-url", authUrl]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Open this link");
    expect(result.stdout).toContain(`Logged in to ${authUrl}`);
  }, 15_000);
  test("prints approval link, polls and privately stores the received token without token input", async () => {
    deviceMode = "approved";
    const result = await cli(["auth", "login", "--auth-url", authUrl, "--name", "Codex", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`${authUrl}/agent/authorize?user_code=${userCode}`);
    expect(result.stderr).toContain(`Check code: ${userCode}`);
    expect(result.json).toEqual({ authenticated: true, authUrl, ...session });
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ authUrl, token });
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/agent/device/start",
      "/api/agent/device/poll",
      "/api/agent/device/poll",
    ]);
    expect(calls.every(({ method, authorization }) => method === "POST" && !authorization)).toBe(
      true,
    );
    deviceMode = null;
    expect((await cli(["auth", "status", "--json"])).json).toEqual({
      authenticated: true,
      authUrl,
      ...session,
    });
  }, 15_000);

  test.each([
    ["denied", "access_denied"],
    ["expired", "expired_request"],
  ] as const)(
    "%s approval preserves previous credentials",
    async (device, code) => {
      await login();
      const previous = await readFile(configFile, "utf8");
      deviceMode = device;
      expect(await cli(["auth", "login", "--auth-url", authUrl, "--json"])).toMatchObject({
        code: 1,
        json: { error: { code } },
      });
      expect(await readFile(configFile, "utf8")).toBe(previous);
    },
    15_000,
  );

  test("backs off on temporary service failure, then finishes approval", async () => {
    deviceMode = "unavailable";
    expect(await cli(["auth", "login", "--auth-url", authUrl, "--json"])).toMatchObject({
      code: 0,
      json: { authenticated: true },
    });
    expect(polls).toBe(2);
  }, 15_000);

  test("honors slow-down responses", async () => {
    deviceMode = "slow";
    const before = Date.now();
    expect((await cli(["auth", "login", "--auth-url", authUrl, "--json"])).code).toBe(0);
    expect(Date.now() - before).toBeGreaterThanOrEqual(7000);
    expect(polls).toBe(2);
  }, 15_000);

  test("stops at the approval deadline without saving a credential", async () => {
    deviceMode = "pending";
    expect(await cli(["auth", "login", "--auth-url", authUrl, "--json"])).toMatchObject({
      code: 1,
      json: { error: { code: "expired_request" } },
    });
    await expect(stat(configFile)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  test("Ctrl+C cancels polling and preserves previous credentials", async () => {
    await login();
    const previous = await readFile(configFile, "utf8");
    deviceMode = "pending";
    let cancelled = false;
    const result = await cli(
      ["auth", "login", "--auth-url", authUrl, "--json"],
      "",
      (child, progress) => {
        if (!cancelled && progress.includes("Waiting for approval")) {
          cancelled = true;
          child.kill("SIGINT");
        }
      },
    );
    expect(result).toMatchObject({ code: 1, json: { error: { code: "cancelled" } } });
    expect(await readFile(configFile, "utf8")).toBe(previous);
    expect(polls).toBe(0);
  }, 10_000);

  test("rejects foreign approval links and invalid options before polling", async () => {
    deviceMode = "foreign";
    const result = await cli(["auth", "login", "--auth-url", authUrl, "--json"]);
    expect(result).toMatchObject({ code: 1, json: { error: { code: "invalid_response" } } });
    expect(result.stderr).not.toContain("evil.example");
    expect(polls).toBe(0);
    const before = calls.length;
    for (const args of [
      ["auth", "status", "--name", "Codex", "--json"],
      ["auth", "login", "--auth-url", authUrl, "--name", "x".repeat(81), "--json"],
      ["auth", "login", "--auth-url", authUrl, "--name", "Codex", "--token-stdin", "--json"],
    ])
      expect((await cli(args, token)).code).toBe(1);
    expect(calls.length).toBe(before);
  }, 15_000);
});
