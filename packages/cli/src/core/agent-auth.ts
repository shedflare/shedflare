import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { object, parse, string, type BaseIssue, type BaseSchema, type InferOutput } from "valibot";
import { AgentTokenSchema } from "@shedflare/auth-client/deployments";

const CredentialSchema = object({ authUrl: string(), token: AgentTokenSchema });
export type AgentCredential = InferOutput<typeof CredentialSchema>;

export class AgentCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function authOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AgentCliError(
      "invalid_auth_url",
      "Use the HTTPS origin of your Shedflare Auth service.",
    );
  }
}

export function credentialPath(): string {
  const base = process.env.XDG_CONFIG_HOME;
  return path.join(
    base && path.isAbsolute(base) ? base : path.join(homedir(), ".config"),
    "shedflare",
    "agent.json",
  );
}

export async function readCredential(): Promise<AgentCredential> {
  let file;
  try {
    file = await open(credentialPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error();
    const credential = parse(CredentialSchema, JSON.parse(await file.readFile("utf8")));
    return { ...credential, authUrl: authOrigin(credential.authUrl) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new AgentCliError(
        "not_logged_in",
        "Run shedflare auth login --auth-url <Auth origin> first.",
      );
    throw new AgentCliError(
      "invalid_credentials",
      "Stored credentials could not be read safely. Run shedflare auth login again.",
    );
  } finally {
    await file?.close();
  }
}

export async function saveCredential(credential: AgentCredential): Promise<void> {
  const destination = credentialPath();
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.agent-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    await chmod(directory, 0o700);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(credential)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
  } catch {
    throw new AgentCliError(
      "credential_storage_failed",
      "Could not save credentials in the user configuration directory.",
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeCredential(): Promise<void> {
  try {
    await rm(credentialPath(), { force: true });
  } catch {
    throw new AgentCliError("credential_storage_failed", "Could not remove stored credentials.");
  }
}

export async function agentRequest<S extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  credential: AgentCredential,
  route: string,
  schema: S,
): Promise<InferOutput<S>> {
  let response: Response;
  try {
    response = await fetch(new URL(route, credential.authUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${credential.token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AgentCliError(
      "service_unavailable",
      "Auth service could not be reached securely. Check the Auth URL and retry.",
    );
  }
  if (response.status === 401)
    throw new AgentCliError(
      "invalid_token",
      "The agent token is expired, revoked, or invalid. Run shedflare auth login again.",
    );
  if (response.status === 404)
    throw new AgentCliError(
      "not_found",
      "The Worker or agent endpoint was not found. Check the Worker name and deployed Auth version.",
    );
  if (!response.ok)
    throw new AgentCliError(
      "service_unavailable",
      "Deployment inspection is unavailable. Check the Auth configuration and retry.",
    );
  try {
    return parse(schema, await response.json());
  } catch {
    throw new AgentCliError(
      "invalid_response",
      "The Auth service returned an invalid response. Check the deployed Auth version.",
    );
  }
}
