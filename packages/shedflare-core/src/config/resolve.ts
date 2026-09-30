import { CoreError } from "../errors.ts";
import type { ManifestCatalog } from "../manifests/model.ts";
import type { ResolvedAppConfig, ShedflareConfig } from "./model.ts";

export function isAppSelected(config: ShedflareConfig, appId: string): boolean {
  if (config.configVersion === 1) {
    const selection = config.apps[appId];
    return selection !== undefined && selection.enabled !== false;
  }
  return config.apps[appId] !== undefined;
}

export function selectedAppIds(config: ShedflareConfig): string[] {
  return Object.keys(config.apps).filter((appId) => isAppSelected(config, appId));
}

function safeStageSuffix(stage: string): string {
  return stage
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-");
}

export function stageSubdomain(subdomain: string, stage: string): string {
  if (stage === "prod") return subdomain;
  const suffix = safeStageSuffix(stage);
  return suffix ? `${subdomain}-${suffix}` : subdomain;
}

/** Select the existing owner of an app's canonical production hostname. */
export function resolveDeploymentStage(
  config: ShedflareConfig,
  catalog: ManifestCatalog,
  appId: string,
  stage = "prod",
): string {
  if (stage !== "prod" || config.configVersion !== 2) return stage;
  const app = resolveAppConfig(config, catalog, appId, stage);
  const owners = Object.entries(config.apps[appId]?.productionAliases ?? {})
    .filter(([, subdomain]) => subdomain === app.configuredSubdomain)
    .map(([ownerStage]) => ownerStage);
  if (owners.length > 1) {
    throw new CoreError("CONFIG_INVALID", `Multiple production owners configured for ${appId}.`);
  }
  return owners[0] ?? stage;
}

export function resolveAppConfig(
  config: ShedflareConfig,
  catalog: ManifestCatalog,
  appId: string,
  stage = "prod",
): ResolvedAppConfig {
  const manifest = catalog.manifests.get(appId);
  if (!manifest) {
    throw new CoreError("CONFIG_UNKNOWN_APP", `Unknown app "${appId}" in the manifest catalog.`);
  }

  const legacySelection = config.configVersion === 1 ? config.apps[appId] : undefined;
  const selection = config.configVersion === 2 ? config.apps[appId] : undefined;
  if (!isAppSelected(config, appId)) {
    throw new CoreError("CONFIG_UNKNOWN_APP", `App "${appId}" is not selected in config.`);
  }

  const configuredSubdomain =
    legacySelection?.subdomain ?? selection?.subdomain ?? manifest.defaultSubdomain;
  const resolvedVars: Record<string, string> = {};
  for (const [name, definition] of Object.entries(manifest.vars)) {
    if (definition.from === "user" && definition.default !== undefined) {
      resolvedVars[name] = definition.default;
    }
  }
  Object.assign(
    resolvedVars,
    config.configVersion === 1 ? (config.vars[appId] ?? {}) : (selection?.vars ?? {}),
  );

  const productionAlias = selection?.productionAliases?.[stage];
  const stageSpecificSubdomain = productionAlias ?? stageSubdomain(configuredSubdomain, stage);
  return {
    appId,
    authStage: productionAlias === undefined ? stage : "prod",
    domain: config.domain,
    configuredSubdomain,
    stageSubdomain: stageSpecificSubdomain,
    url: `https://${stageSpecificSubdomain}.${config.domain}`,
    ownerEmail: config.ownerEmail,
    vars: resolvedVars,
  };
}
