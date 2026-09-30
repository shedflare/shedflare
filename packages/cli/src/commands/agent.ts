import { open } from "node:fs/promises";
import { password, isCancel } from "@clack/prompts";
import { parse, safeParse, type InferOutput } from "valibot";
import {
  AgentSessionSchema,
  AgentTokenSchema,
  DeploymentHistorySchema,
  WorkerInventorySchema,
  WorkerNameSchema,
} from "@shedflare/auth-client/deployments";
import {
  AgentCliError,
  agentRequest,
  authOrigin,
  readCredential,
  removeCredential,
  saveCredential,
} from "../core/agent-auth.js";
import { browserLogin } from "../core/device-login.js";

export type AgentOptions = {
  authUrl?: string;
  tokenStdin?: boolean;
  tokenFile?: string;
  json?: boolean;
  name?: string;
  tokenPrompt?: boolean;
};

type AgentOutput =
  | InferOutput<typeof WorkerInventorySchema>
  | InferOutput<typeof DeploymentHistorySchema>
  | ({ authenticated: true; authUrl: string } & InferOutput<typeof AgentSessionSchema>)
  | { loggedOut: true };

function output(value: AgentOutput, message: string, json?: boolean) {
  console.log(json ? JSON.stringify(value) : message);
}

async function readToken(options: AgentOptions): Promise<string> {
  if ([options.tokenStdin, options.tokenFile, options.tokenPrompt].filter(Boolean).length > 1)
    throw new AgentCliError("invalid_input", "Choose one token input method.");
  let input: string;
  if (options.tokenStdin) {
    if (process.stdin.isTTY)
      throw new AgentCliError(
        "invalid_input",
        "Pipe a token to --token-stdin, or omit it for a hidden prompt.",
      );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 4096) throw new AgentCliError("invalid_input", "Token input is too large.");
      chunks.push(buffer);
    }
    input = Buffer.concat(chunks).toString("utf8");
  } else if (options.tokenFile) {
    try {
      // Read a bounded amount even if a file is unexpectedly large.
      const file = await open(options.tokenFile, "r");
      try {
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer);
        if (bytesRead > 4096) throw new Error();
        input = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    } catch {
      throw new AgentCliError("invalid_input", "Could not read the token file.");
    }
  } else {
    if (!process.stdin.isTTY || options.json)
      throw new AgentCliError(
        "invalid_input",
        "Use --token-stdin or --token-file for non-interactive login.",
      );
    const result = await password({ message: "Agent token from your Auth /tokens page" });
    if (isCancel(result)) throw new AgentCliError("cancelled", "Login cancelled.");
    input = result;
  }
  const result = safeParse(AgentTokenSchema, input.trim());
  if (!result.success)
    throw new AgentCliError("invalid_input", "Expected a Shedflare agent token.");
  return result.output;
}

async function auth(action: string, options: AgentOptions): Promise<void> {
  if (action === "login") {
    if (!options.authUrl)
      throw new AgentCliError("invalid_input", "Login requires --auth-url <Auth origin>.");
    const authUrl = authOrigin(options.authUrl);
    const manual = options.tokenStdin || options.tokenFile || options.tokenPrompt;
    if (manual && options.name)
      throw new AgentCliError("invalid_input", "--name applies only to browser login.");
    if (!manual) {
      const issued = await browserLogin({ authUrl, name: options.name });
      await saveCredential({ authUrl, token: issued.token });
      const session = { name: issued.name, scope: issued.scope, expiresAt: issued.expiresAt };
      output(
        { authenticated: true, authUrl, ...session },
        `Logged in to ${authUrl} (${session.scope}); expires ${new Date(session.expiresAt).toISOString()}.`,
        options.json,
      );
      return;
    }
    const token = await readToken(options);
    const session = await agentRequest(
      { authUrl, token },
      "/api/agent/session",
      AgentSessionSchema,
    );
    await saveCredential({ authUrl, token });
    output(
      { authenticated: true, authUrl, ...session },
      `Logged in to ${authUrl} (${session.scope}); expires ${new Date(session.expiresAt).toISOString()}.`,
      options.json,
    );
    return;
  }
  if (
    options.authUrl ||
    options.tokenStdin ||
    options.tokenFile ||
    options.tokenPrompt ||
    options.name
  )
    throw new AgentCliError(
      "invalid_input",
      "Token and Auth URL options apply only to auth login.",
    );
  if (action === "status") {
    const credential = await readCredential();
    const session = await agentRequest(credential, "/api/agent/session", AgentSessionSchema);
    output(
      { authenticated: true, authUrl: credential.authUrl, ...session },
      `Logged in to ${credential.authUrl} (${session.scope}); expires ${new Date(session.expiresAt).toISOString()}.`,
      options.json,
    );
    return;
  }
  if (action === "logout") {
    await removeCredential();
    output(
      { loggedOut: true },
      "Local credentials removed. Revoke the token on the Auth /tokens page to invalidate other copies.",
      options.json,
    );
    return;
  }
  throw new AgentCliError("invalid_input", "Use auth login, auth status, or auth logout.");
}

async function deployments(action: string, worker: string | undefined, options: AgentOptions) {
  if (action !== "list" && action !== "history")
    throw new AgentCliError(
      "invalid_input",
      "Use deployments list or deployments history <worker>.",
    );
  if (action === "list" && worker !== undefined)
    throw new AgentCliError("invalid_input", "deployments list does not take a Worker name.");
  if (action === "history" && !safeParse(WorkerNameSchema, worker).success)
    throw new AgentCliError("invalid_input", "history requires a valid Worker name.");
  const credential = await readCredential();
  if (action === "list") {
    const inventory = await agentRequest(credential, "/api/deployments", WorkerInventorySchema);
    output(
      inventory,
      inventory.workers.map((item) => `${item.id}\t${item.modified_on ?? "unknown"}`).join("\n") ||
        "No Workers found.",
      options.json,
    );
  } else {
    const name = parse(WorkerNameSchema, worker);
    const history = await agentRequest(
      credential,
      `/api/deployments?worker=${encodeURIComponent(name)}`,
      DeploymentHistorySchema,
    );
    if (history.worker !== name)
      throw new AgentCliError(
        "invalid_response",
        "The Auth service returned history for a different Worker.",
      );
    output(
      history,
      history.deployments
        .map(
          (item) =>
            `${item.created_on}\t${item.id}\t${item.versions.map((version) => `${version.version_id} (${version.percentage}%)`).join(", ")}`,
        )
        .join("\n") || "No deployments found.",
      options.json,
    );
  }
}

export async function agentCommand(
  group: "auth" | "deployments",
  action: string,
  worker: string | undefined,
  options: AgentOptions,
): Promise<void> {
  try {
    if (group === "auth") await auth(action, options);
    else await deployments(action, worker, options);
  } catch (error) {
    const failure =
      error instanceof AgentCliError
        ? error
        : new AgentCliError("command_failed", "The agent command failed. Please retry.");
    if (options.json)
      console.log(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
    else console.error(failure.message);
    process.exitCode = 1;
  }
}
