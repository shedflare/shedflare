import { stdout as output } from "node:process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  listWorkerSecretNames,
  loadCloudflareCredentials,
  putWorkerSecret,
} from "@shedflare/alchemy";
import { getWorkspaceRoot, isAppId, loadManifest } from "../core/manifests.js";
import { assertEnabledApp, physicalWorkerName } from "../core/worker-names.js";

export type SecretSetDestination = "remote" | "local" | "both";

export type SecretCommand =
  | { readonly action: "list"; readonly app: string }
  | {
      readonly action: "set";
      readonly app: string;
      readonly name: string;
      readonly value?: string;
      readonly destination: SecretSetDestination;
    };

export interface SecretSetOptions {
  app: string;
  name: string;
  value?: string;
  destination?: SecretSetDestination;
}

export interface SecretListOptions {
  app: string;
}

export interface SecretValues {
  [name: string]: string;
}

export function resolveSecretSetDestination(options: {
  local?: boolean;
  both?: boolean;
}): SecretSetDestination {
  if (options.local && options.both) {
    throw new Error("Choose either --local or --both, not both.");
  }
  if (options.local) return "local";
  if (options.both) return "both";
  return "remote";
}

export function resolveSecretCommand(options: {
  action: string;
  app: string;
  name?: string;
  value?: string;
  local?: boolean;
  both?: boolean;
}): SecretCommand {
  if (options.action === "list") {
    if (options.name || options.value || options.local || options.both) {
      throw new Error("Usage: shedflare secret list <app>");
    }
    return { action: "list", app: options.app };
  }

  if (options.action === "set") {
    if (!options.name) {
      throw new Error("Usage: shedflare secret set <app> <name>");
    }
    return {
      action: "set",
      app: options.app,
      name: options.name,
      value: options.value,
      destination: resolveSecretSetDestination(options),
    };
  }

  throw new Error(`Unknown secret action: ${options.action}. Use "set" or "list".`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertDotEnvValue(source: string, name: string, value: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `${name}=${JSON.stringify(value)}`;
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`);
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  let replaced = false;
  const updated = lines.flatMap((line) => {
    if (!matcher.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    return [assignment];
  });

  if (!replaced) updated.push(assignment);
  return `${updated.join(newline)}${newline}`;
}

export function writeLocalSecret(options: { filePath: string; name: string; value: string }): void {
  const source = existsSync(options.filePath) ? readFileSync(options.filePath, "utf8") : "";
  writeFileSync(options.filePath, upsertDotEnvValue(source, options.name, options.value), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(options.filePath, 0o600);
}

async function readSecret(prompt: string): Promise<string> {
  output.write(prompt);
  const tty = openSync("/dev/tty", "r");
  let value = "";
  const buf = Buffer.alloc(1);
  try {
    for (;;) {
      const bytesRead = readSync(tty, buf, 0, 1, null);
      if (bytesRead === 0) break;
      const ch = buf[0];
      if (ch === 0x0a || ch === 0x0d) break; // newline / carriage return
      if (ch === 0x7f || ch === 0x08) {
        // backspace / delete
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
      } else if (ch >= 0x20) {
        value += String.fromCharCode(ch);
        output.write("*");
      }
    }
  } finally {
    closeSync(tty);
  }
  output.write("\n");
  return value.trim();
}

export async function secretSetCommand(options: SecretSetOptions): Promise<void> {
  if (!isAppId(options.app)) {
    console.error(`Unknown app: ${options.app}`);
    process.exit(1);
  }

  try {
    assertEnabledApp(options.app);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const manifest = loadManifest(options.app);
  const definition = manifest.secrets[options.name];
  if (!definition) {
    console.error(
      `Secret "${options.name}" is not declared in apps/${options.app}/shedflare.app.jsonc`,
    );
    process.exit(1);
  }
  if (definition.source === "generated") {
    console.error(`Secret "${options.name}" is generated and cannot be set by the operator.`);
    process.exit(1);
  }

  let value = options.value;
  if (!value) {
    value = await readSecret(`Value for ${options.name}: `);
  }

  if (!value) {
    console.error("Secret value is required.");
    process.exit(1);
  }

  const destination = options.destination ?? "remote";
  if (destination === "remote" || destination === "both") {
    const workerName = physicalWorkerName(options.app);
    const credentials = await loadCloudflareCredentials();
    await putWorkerSecret(credentials, credentials.accountId, workerName, options.name, value);
    console.log(`Set ${options.name} on worker ${workerName}`);
  }

  if (destination === "local" || destination === "both") {
    const filePath = join(getWorkspaceRoot(), ".env");
    writeLocalSecret({ filePath, name: options.name, value });
    console.log(`Set ${options.name} in ${filePath}`);
  }
}

export async function secretListCommand(options: SecretListOptions): Promise<void> {
  if (!isAppId(options.app)) {
    console.error(`Unknown app: ${options.app}`);
    process.exit(1);
  }

  try {
    assertEnabledApp(options.app);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const manifest = loadManifest(options.app);
  const workerName = physicalWorkerName(options.app);
  const credentials = await loadCloudflareCredentials();
  const setOnWorker = await listWorkerSecretNames(credentials, credentials.accountId, workerName);

  console.log(`Worker: ${workerName}\n`);
  for (const [name, def] of Object.entries(manifest.secrets)) {
    if (def.source === "generated") {
      console.log(`  ${name}: managed by Alchemy`);
      continue;
    }
    const present = setOnWorker.includes(name);
    const status = present ? "set" : def.required ? "missing (required)" : "missing (optional)";
    console.log(`  ${name}: ${status}`);
  }
}

/** Parse --secret NAME=VALUE flags for deploy. */
export function parseSecretFlags(argv: string[]): SecretValues {
  const secrets: SecretValues = {};
  for (const arg of argv) {
    if (!arg.startsWith("--secret=")) continue;
    console.warn(
      "[shedflare] --secret=NAME=value is deprecated and exposes secrets in shell history and process listings. Use environment variables instead (e.g. SECRET_NAME=value pnpm deploy).",
    );
    const pair = arg.slice("--secret=".length);
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    secrets[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return secrets;
}

export async function promptMissingSecrets(
  missing: Array<{ appId: string; names: string[] }>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};

  for (const { appId, names } of missing) {
    for (const name of names) {
      const answer = await readSecret(`${appId}: ${name}: `);
      if (!answer) {
        throw new Error(`Missing required secret ${name} for ${appId}`);
      }
      values[name] = answer;
    }
  }

  return values;
}

/**
 * Values present before a deploy injected a secret. Deploys load the repository
 * `.env` first, so clearing must restore what was already there instead of
 * deleting operator-provided values.
 */
const injectedSecretValues = new Map<string, string | undefined>();

export function applySecretsToEnv(secrets: Record<string, string>): void {
  for (const [name, value] of Object.entries(secrets)) {
    if (!injectedSecretValues.has(name)) {
      injectedSecretValues.set(name, process.env[name]);
    }
    process.env[name] = value;
  }
}

export function clearSecretsFromEnv(names: string[]): void {
  for (const name of names) {
    const previous = injectedSecretValues.get(name);
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
    injectedSecretValues.delete(name);
  }
}
