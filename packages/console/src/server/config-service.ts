import {
  discoverManifests,
  inspectConfig,
  loadManifest as loadCoreManifest,
  patchConfig as patchCoreConfig,
  resolveAppConfig,
  resolveDeploymentStage,
  type AppManifest,
  type ShedflareConfig,
} from "@shedflare/core";
import { REPO_ROOT } from "./repo-root.ts";

export type { ShedflareConfig } from "@shedflare/core";

export interface ManifestSummary {
  id: string;
  name: string;
  description: string;
  lifecycle: AppManifest["lifecycle"];
  category: AppManifest["category"];
  dataSensitivity: AppManifest["dataSensitivity"];
  dependsOn: string[];
  defaultSubdomain: string;
  secretNames: string[];
  resourceTypes: string[];
}

function catalog() {
  return discoverManifests(REPO_ROOT);
}

export function configPath(): string {
  return `${REPO_ROOT}/shedflare.config.jsonc`;
}

export function loadConfig(): ShedflareConfig | null {
  return inspectConfig(REPO_ROOT, catalog()).config ?? null;
}

export function discoverAppIds(): string[] {
  return [...catalog().appIds];
}

export function loadManifest(appId: string): ManifestSummary | null {
  try {
    const manifest = loadCoreManifest(REPO_ROOT, appId);
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      lifecycle: manifest.lifecycle,
      category: manifest.category,
      dataSensitivity: manifest.dataSensitivity,
      dependsOn: [...manifest.dependsOn],
      defaultSubdomain: manifest.defaultSubdomain,
      secretNames: Object.keys(manifest.secrets),
      resourceTypes: manifest.resources.map((resource) => resource.type),
    };
  } catch {
    return null;
  }
}

export function appUrl(config: ShedflareConfig, appId: string, stage = "prod"): string | null {
  try {
    return resolveAppConfig(config, catalog(), appId, stage).url;
  } catch {
    return null;
  }
}

export function appDeploymentStage(config: ShedflareConfig, appId: string, stage = "prod"): string {
  return resolveDeploymentStage(config, catalog(), appId, stage);
}

export function patchConfig<Patch>(value: Patch): ShedflareConfig {
  return patchCoreConfig(REPO_ROOT, value, catalog());
}
