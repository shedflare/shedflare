import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDotPath, looseObject, optional, safeParse, unknown } from "valibot";
import { CoreError } from "../errors.ts";
import { parseJsonc } from "../jsonc.ts";
import type { ManifestCatalog } from "../manifests/model.ts";
import { configPath } from "../paths.ts";
import type {
  AppSelection,
  ConfigInspection,
  LegacyAppSelection,
  ShedflareConfig,
  ShedflareConfigV1,
  ShedflareConfigV2,
} from "./model.ts";
import { ShedflareConfigV1Schema, ShedflareConfigV2Schema } from "./schema.ts";

const ConfigHeaderSchema = looseObject({ configVersion: optional(unknown()) });

function parseConfigVersionOne<Input>(input: Input): ShedflareConfigV1 {
  const result = safeParse(ShedflareConfigV1Schema, input);
  if (!result.success) {
    const issue = result.issues[0];
    const fieldPath = getDotPath(issue) ?? undefined;
    throw new CoreError("CONFIG_INVALID", `${fieldPath ? `${fieldPath}: ` : ""}${issue.message}`, {
      fieldPath,
      expectation: issue.expected ?? undefined,
    });
  }

  const config = result.output;
  const parsed = {
    configVersion: 1,
    domain: config.domain,
    ownerEmail: config.ownerEmail,
    apps: Object.fromEntries(
      Object.entries(config.apps).map(([appId, selection]) => [
        appId,
        (() => {
          const app = { subdomain: selection.subdomain } satisfies LegacyAppSelection;
          return selection.enabled === undefined
            ? app
            : ({ ...app, enabled: selection.enabled } satisfies LegacyAppSelection);
        })(),
      ]),
    ),
    vars: Object.fromEntries(
      Object.entries(config.vars ?? {}).map(([appId, vars]) => [appId, { ...vars }]),
    ),
    resources: Object.fromEntries(
      Object.entries(config.resources ?? {}).map(([appId, resources]) => [appId, { ...resources }]),
    ),
  } satisfies ShedflareConfigV1;
  return config.$schema === undefined ? parsed : { ...parsed, $schema: config.$schema };
}

function parseConfigVersionTwo<Input>(input: Input): ShedflareConfigV2 {
  const result = safeParse(ShedflareConfigV2Schema, input);
  if (!result.success) {
    const issue = result.issues[0];
    const fieldPath = getDotPath(issue) ?? undefined;
    throw new CoreError("CONFIG_INVALID", `${fieldPath ? `${fieldPath}: ` : ""}${issue.message}`, {
      fieldPath,
      expectation: issue.expected ?? undefined,
    });
  }

  const config = result.output;
  const parsed = {
    configVersion: 2,
    domain: config.domain,
    ownerEmail: config.ownerEmail,
    apps: Object.fromEntries(
      Object.entries(config.apps).map(([appId, selection]) => [
        appId,
        (() => {
          const app: typeof selection = {};
          if (selection.subdomain !== undefined) app.subdomain = selection.subdomain;
          if (selection.vars !== undefined) app.vars = { ...selection.vars };
          if (selection.productionAliases !== undefined) {
            app.productionAliases = { ...selection.productionAliases };
          }
          return app satisfies AppSelection;
        })(),
      ]),
    ),
  } satisfies ShedflareConfigV2;
  return config.$schema === undefined ? parsed : { ...parsed, $schema: config.$schema };
}

function assertKnownApps(config: ShedflareConfig, catalog: ManifestCatalog): void {
  const appIds = new Set<string>(Object.keys(config.apps));
  if (config.configVersion === 1) {
    for (const appId of Object.keys(config.vars)) appIds.add(appId);
    for (const appId of Object.keys(config.resources)) appIds.add(appId);
  }

  for (const appId of appIds) {
    if (!catalog.manifests.has(appId)) {
      throw new CoreError(
        "CONFIG_UNKNOWN_APP",
        `Unknown app "${appId}" in config. Regenerate the registry if this app was added, or remove stale config.`,
        { fieldPath: `apps.${appId}` },
      );
    }
  }
}

export function validateConfig<Input>(input: Input, catalog: ManifestCatalog): ShedflareConfig {
  const header = safeParse(ConfigHeaderSchema, input);
  if (!header.success) {
    throw new CoreError("CONFIG_INVALID", "Config must be an object.");
  }

  const versionValue = header.output.configVersion;
  if (versionValue !== undefined && versionValue !== 2) {
    throw new CoreError(
      "CONFIG_VERSION_UNSUPPORTED",
      `Unsupported configVersion ${JSON.stringify(versionValue) ?? "undefined"}. Supported versions are 1 and 2.`,
      { fieldPath: "configVersion" },
    );
  }

  const config = versionValue === 2 ? parseConfigVersionTwo(input) : parseConfigVersionOne(input);
  assertKnownApps(config, catalog);
  if (config.configVersion === 2) {
    for (const [appId, selection] of Object.entries(config.apps)) {
      if (
        Object.keys(selection.productionAliases ?? {}).length > 0 &&
        !catalog.manifests.get(appId)?.dependsOn.includes("auth")
      ) {
        throw new CoreError("CONFIG_INVALID", "Production aliases require an Auth consumer.", {
          fieldPath: `apps.${appId}.productionAliases`,
        });
      }
    }
  }
  return config;
}

export function inspectConfig(root: string, catalog: ManifestCatalog): ConfigInspection {
  const path = configPath(root);
  if (!existsSync(path)) return { configPath: path, present: false, warnings: [] };

  const source = readFileSync(path, "utf8");
  const config = validateConfig(parseJsonc(source, path, "CONFIG_PARSE_ERROR"), catalog);
  return {
    configPath: path,
    present: true,
    config,
    warnings:
      config.configVersion === 1
        ? ["Config version 1 is readable but should be migrated explicitly to version 2."]
        : [],
  };
}

export function loadConfig(root: string, catalog: ManifestCatalog): ShedflareConfig {
  const inspection = inspectConfig(root, catalog);
  if (!inspection.config) {
    throw new CoreError(
      "CONFIG_NOT_FOUND",
      `${inspection.configPath} not found. Run \`shedflare init\` or set up the Console first.`,
      { filePath: inspection.configPath },
    );
  }
  return inspection.config;
}

export function writeConfig(
  root: string,
  config: ShedflareConfigV2,
  catalog: ManifestCatalog,
): void {
  const validated = validateConfig(config, catalog);
  if (validated.configVersion !== 2) {
    throw new CoreError("CONFIG_VERSION_UNSUPPORTED", "New config writes require version 2.");
  }
  writeFileSync(configPath(root), `${JSON.stringify(validated, null, 2)}\n`);
}
