import spawn from "nano-spawn";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, isAppId, type AppId } from "../core/manifests.js";
import { isAppSelected, loadConfig, validateConfig } from "../core/config.js";
import { parseSecretFlags, applySecretsToEnv, clearSecretsFromEnv } from "./secret.js";
import { discoverManifests, findRepoRoot, resolveDeploymentStage } from "@shedflare/core";
import { loadRepoDotEnv } from "@shedflare/alchemy";

export interface DeployOptions {
  app?: string;
  yes?: boolean;
  profile?: string;
}

export interface AlchemyDeployInvocation {
  readonly target: string;
  readonly stage: string;
  /** Absolute path to the repository `.env`, passed so Alchemy does not depend on the caller's cwd. */
  readonly envFile?: string;
  /** Alchemy auth profile name. Defaults to Alchemy's own `default` profile. */
  readonly profile?: string;
}

/**
 * Build the Alchemy argument list. `--env-file` must only be passed when a real
 * file exists: Alchemy's `loadConfigProvider` skips its automatic `.env` branch
 * whenever the flag is present, so passing an empty file silently hides the
 * repository environment from every config lookup.
 */
export function alchemyDeployArgs({
  target,
  stage,
  envFile,
  profile,
}: AlchemyDeployInvocation): string[] {
  return [
    "exec",
    "alchemy",
    "deploy",
    target,
    "--stage",
    stage,
    ...(envFile ? ["--env-file", envFile] : []),
    ...(profile ? ["--profile", profile] : []),
    "--yes",
  ];
}

export async function deployCommand(options: DeployOptions): Promise<void> {
  const repoRoot = findRepoRoot();
  loadRepoDotEnv(repoRoot);

  if (options.app === "drive") {
    console.error(
      "Drive has an independent production lifecycle and is unavailable through the suite deploy command. Use its scoped workspace deployment command only with explicit production approval.",
    );
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error("shedflare.config.jsonc not found. Run `shedflare init` first.");
    process.exit(1);
  }

  const validation = validateConfig(config);
  if (!validation.success) {
    console.error("Invalid shedflare.config.jsonc:", validation.error);
    process.exit(1);
  }

  const validConfig = validation.value;

  let selectedApp: AppId | undefined;
  if (options.app) {
    if (!isAppId(options.app)) {
      console.error(`Unknown app: ${options.app}`);
      process.exit(1);
    } else {
      selectedApp = options.app;
    }
  }

  if (options.app && !isAppSelected(validConfig, options.app)) {
    console.error(`App "${options.app}" is not enabled in config.`);
    process.exit(1);
  }

  const appIds: AppId[] = selectedApp
    ? [selectedApp]
    : Object.keys(validConfig.apps)
        .filter((id) => isAppSelected(validConfig, id))
        .filter((id) => id !== "drive")
        .filter(isAppId);

  if (appIds.length === 0) {
    console.error("No enabled apps to deploy.");
    process.exit(1);
  }

  const catalog = discoverManifests(repoRoot);
  const stage = selectedApp ? resolveDeploymentStage(validConfig, catalog, selectedApp) : "prod";
  if (
    !selectedApp &&
    appIds.some((id) => resolveDeploymentStage(validConfig, catalog, id) !== "prod")
  ) {
    throw new Error(
      "The suite contains legacy production stages. Deploy its apps individually to preserve existing ownership.",
    );
  }

  // Parse --secret flags
  const flagSecrets = parseSecretFlags(process.argv.slice(2));

  // Collect all secret names we might have injected
  const allRequiredSecrets = new Set<string>();
  for (const appId of appIds) {
    try {
      const manifest = loadManifest(appId);
      for (const [name, definition] of Object.entries(manifest.secrets)) {
        if (definition.source === "operator") allRequiredSecrets.add(name);
      }
    } catch {
      /* ignore */
    }
  }

  applySecretsToEnv(flagSecrets);

  const repoEnvFile = join(repoRoot, ".env");

  try {
    const target = options.app ? `apps/${options.app}/alchemy.run.ts` : "alchemy.run.ts";

    console.log(`Deploying via Alchemy: ${target}...`);
    await spawn(
      "vp",
      alchemyDeployArgs({
        target,
        stage,
        envFile: existsSync(repoEnvFile) ? repoEnvFile : undefined,
        profile: options.profile,
      }),
      {
        stdio: "inherit",
      },
    );
  } finally {
    clearSecretsFromEnv([...allRequiredSecrets]);
  }
}
