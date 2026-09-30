import { listWorkerSecretNames, stageSubdomain, type CfCredentials } from "@shedflare/alchemy";
import * as Redacted from "effect/Redacted";
import type { CfEnv } from "./env.ts";
import { cfGet, verifyCfToken } from "./cf-client.ts";
import {
  cfDashboardUrl,
  physicalWorkerName,
  resolveDeployStage,
  workerDashboardUrl,
} from "./env.ts";
import { resolveCurrentStage } from "./stage-service.ts";
import {
  appUrl,
  appDeploymentStage,
  discoverAppIds,
  loadConfig,
  loadManifest,
  type ManifestSummary,
} from "./config-service.ts";
import { array, object, optional, string, type GenericSchema, type InferOutput } from "valibot";

export interface WorkerScript {
  id: string;
  created_on?: string;
  modified_on?: string;
}

export interface D1Database {
  uuid: string;
  name: string;
  created_at?: string;
}

export interface R2Bucket {
  name: string;
  creation_date?: string;
}

export interface KvNamespace {
  id: string;
  title: string;
}

export interface CfInventory {
  workers: WorkerScript[];
  d1: D1Database[];
  r2: R2Bucket[];
  kv: KvNamespace[];
}

export interface CfInventoryResult {
  inventory: CfInventory;
  errors: string[];
}

const WorkerScriptSchema = object({
  id: string(),
  created_on: optional(string()),
  modified_on: optional(string()),
});
const D1DatabaseSchema = object({
  uuid: string(),
  name: string(),
  created_at: optional(string()),
});
const R2BucketSchema = object({ name: string(), creation_date: optional(string()) });
const KvNamespaceSchema = object({ id: string(), title: string() });

function errorMessage<ErrorValue>(label: string, error: ErrorValue): string {
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

export async function fetchInventory(env: CfEnv): Promise<CfInventoryResult> {
  const accountId = env.accountId;
  const token = env.apiToken;
  const errors: string[] = [];

  async function list<ResultSchema extends GenericSchema>(
    label: string,
    path: string,
    schema: ResultSchema,
    fallback: InferOutput<ResultSchema>,
  ): Promise<InferOutput<ResultSchema>> {
    try {
      return await cfGet(token, path, schema);
    } catch (error) {
      errors.push(errorMessage(label, error));
      return fallback;
    }
  }

  const [workers, d1, r2, kv] = await Promise.all([
    list("workers", `/accounts/${accountId}/workers/scripts`, array(WorkerScriptSchema), []),
    list("d1", `/accounts/${accountId}/d1/database`, array(D1DatabaseSchema), []),
    list(
      "r2",
      `/accounts/${accountId}/r2/buckets`,
      object({ buckets: optional(array(R2BucketSchema)) }),
      {},
    ).then((result) => result.buckets ?? []),
    list("kv", `/accounts/${accountId}/storage/kv/namespaces`, array(KvNamespaceSchema), []),
  ]);

  return { inventory: { workers, d1, r2, kv }, errors };
}

export interface AppStatus {
  id: string;
  manifest: ManifestSummary | null;
  enabled: boolean;
  subdomain: string;
  url: string | null;
  workerName: string;
  workerDeployed: boolean;
  dashboardUrl: string;
  secrets: Array<{ name: string; set: boolean }>;
}

export async function buildAppStatuses(
  env: CfEnv,
  inventory: CfInventory,
  stage?: string,
): Promise<AppStatus[]> {
  const config = loadConfig();
  const workerIds = new Set(inventory.workers.map((w) => w.id));
  const appIds = discoverAppIds();

  const credentials: CfCredentials = {
    type: "apiToken",
    apiToken: Redacted.make(env.apiToken),
    accountId: env.accountId,
  };

  stage ??= resolveDeployStage();
  const statuses: AppStatus[] = [];

  for (const id of appIds) {
    const manifest = loadManifest(id);
    const entry = config?.apps[id];
    const enabled =
      config?.configVersion === 1
        ? !!config.apps[id] && config.apps[id].enabled !== false
        : !!entry;
    const configuredSubdomain = entry?.subdomain ?? manifest?.defaultSubdomain ?? id;
    const deploymentStage = enabled && config ? appDeploymentStage(config, id, stage) : stage;
    const url = config ? appUrl(config, id, deploymentStage) : null;
    const subdomain =
      url && config
        ? new URL(url).hostname.slice(0, -(config.domain.length + 1))
        : stageSubdomain(configuredSubdomain, deploymentStage);
    const workerName = physicalWorkerName(id, deploymentStage);
    const workerDeployed = workerIds.has(workerName);

    let secrets: Array<{ name: string; set: boolean }> = [];
    if (manifest && workerDeployed) {
      try {
        const namesOnCf = new Set(
          await listWorkerSecretNames(credentials, env.accountId, workerName),
        );
        secrets = manifest.secretNames.map((name) => ({
          name,
          set: namesOnCf.has(name),
        }));
      } catch {
        secrets = manifest.secretNames.map((name) => ({ name, set: false }));
      }
    } else if (manifest) {
      secrets = manifest.secretNames.map((name) => ({ name, set: false }));
    }

    statuses.push({
      id,
      manifest,
      enabled,
      subdomain,
      url,
      workerName,
      workerDeployed,
      dashboardUrl: workerDashboardUrl(env.accountId, workerName),
      secrets,
    });
  }

  return statuses;
}

export interface SuiteOverview {
  configPresent: boolean;
  domain?: string;
  ownerEmail?: string;
  deployStage: string;
  accountId: string;
  cfTokenValid: boolean;
  apps: AppStatus[];
  inventory: CfInventory;
  inventoryErrors: string[];
  dashboardLinks: {
    workers: string;
    d1: string;
    r2: string;
    observability: string;
    billing: string;
  };
}

export async function fetchSuiteOverview(env: CfEnv, stage?: string): Promise<SuiteOverview> {
  const config = loadConfig();
  const { inventory, errors: inventoryErrors } = await fetchInventory(env);
  const apps = await buildAppStatuses(env, inventory, stage);
  const accountId = env.accountId;
  const cfTokenValid = await verifyCfToken(env.apiToken, accountId);

  const resolvedStage = stage ?? resolveCurrentStage(inventory);

  return {
    configPresent: Boolean(config),
    domain: config?.domain,
    ownerEmail: config?.ownerEmail,
    deployStage: resolvedStage,
    accountId,
    cfTokenValid,
    apps,
    inventory,
    inventoryErrors,
    dashboardLinks: {
      workers: cfDashboardUrl(accountId, "/workers-and-pages"),
      d1: cfDashboardUrl(accountId, "/workers/d1"),
      r2: cfDashboardUrl(accountId, "/r2/overview"),
      observability: cfDashboardUrl(accountId, "/workers-and-pages/observability"),
      billing: cfDashboardUrl(accountId, "/billing"),
    },
  };
}
