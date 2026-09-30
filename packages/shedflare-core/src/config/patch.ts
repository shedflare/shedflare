import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { getDotPath, safeParse } from "valibot";
import { CoreError } from "../errors.ts";
import { parseJsonc } from "../jsonc.ts";
import type { ManifestCatalog } from "../manifests/model.ts";
import { configPath } from "../paths.ts";
import { loadConfig, validateConfig } from "./load.ts";
import type { ConfigPatch, ShedflareConfigV2 } from "./model.ts";
import { ConfigPatchSchema } from "./schema.ts";

function validateConfigPatch<Input>(input: Input, catalog: ManifestCatalog): ConfigPatch {
  const result = safeParse(ConfigPatchSchema, input);
  if (!result.success) {
    const issue = result.issues[0];
    throw new CoreError("CONFIG_INVALID", issue.message, {
      fieldPath: getDotPath(issue) ?? undefined,
      expectation: issue.expected ?? undefined,
    });
  }
  for (const appId of Object.keys(result.output.apps ?? {})) {
    if (!catalog.manifests.has(appId)) {
      throw new CoreError("CONFIG_UNKNOWN_APP", `Unknown app "${appId}" in config patch.`, {
        fieldPath: `apps.${appId}`,
      });
    }
  }
  return result.output;
}

function applyEdit(
  text: string,
  path: (string | number)[],
  value: Parameters<typeof modify>[2],
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
}

export function patchConfig<Patch>(
  root: string,
  patch: Patch,
  catalog: ManifestCatalog,
): ShedflareConfigV2 {
  const normalizedPatch = validateConfigPatch(patch, catalog);
  const path = configPath(root);
  const current = loadConfig(root, catalog);
  if (current.configVersion !== 2) {
    throw new CoreError(
      "CONFIG_VERSION_UNSUPPORTED",
      "Config version 1 must be migrated before applying comment-preserving patches.",
    );
  }

  let nextText = readFileSync(path, "utf8");
  if (normalizedPatch.domain !== undefined) {
    nextText = applyEdit(nextText, ["domain"], normalizedPatch.domain);
  }
  if (normalizedPatch.ownerEmail !== undefined) {
    nextText = applyEdit(nextText, ["ownerEmail"], normalizedPatch.ownerEmail);
  }
  for (const [appId, appPatch] of Object.entries(normalizedPatch.apps ?? {})) {
    if (appPatch === null) {
      nextText = applyEdit(nextText, ["apps", appId], undefined);
      continue;
    }
    if (!current.apps[appId]) nextText = applyEdit(nextText, ["apps", appId], {});
    if (appPatch.subdomain !== undefined) {
      nextText = applyEdit(
        nextText,
        ["apps", appId, "subdomain"],
        appPatch.subdomain === null ? undefined : appPatch.subdomain,
      );
    }
    if (appPatch.productionAliases === null) {
      nextText = applyEdit(nextText, ["apps", appId, "productionAliases"], undefined);
    } else {
      for (const [stage, subdomain] of Object.entries(appPatch.productionAliases ?? {})) {
        nextText = applyEdit(
          nextText,
          ["apps", appId, "productionAliases", stage],
          subdomain === null ? undefined : subdomain,
        );
      }
    }
    if (appPatch.vars === null) {
      nextText = applyEdit(nextText, ["apps", appId, "vars"], undefined);
      continue;
    }
    for (const [name, value] of Object.entries(appPatch.vars ?? {})) {
      nextText = applyEdit(
        nextText,
        ["apps", appId, "vars", name],
        value === null ? undefined : value,
      );
    }
  }

  const nextConfig = validateConfig(parseJsonc(nextText, path, "CONFIG_PARSE_ERROR"), catalog);
  if (nextConfig.configVersion !== 2) {
    throw new CoreError("CONFIG_VERSION_UNSUPPORTED", "Patched config must use version 2.");
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporaryPath, nextText);
  renameSync(temporaryPath, path);
  return nextConfig;
}
