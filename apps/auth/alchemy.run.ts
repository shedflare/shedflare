import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mergeAdditionalAllowedClients } from "./allowed-clients.ts";

export const AuthStack = Alchemy.Stack(
  "ShedflareAuth",
  {
    providers: Shedflare.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("auth");
    const rootConfig = Shedflare.loadShedflareConfig();
    const catalog = Shedflare.discoverManifests(Shedflare.findRepoRoot());
    const clientApps = catalog.appIds.filter(
      (appId): appId is Shedflare.AppId =>
        Shedflare.isAppId(appId) &&
        appId !== "auth" &&
        (catalog.manifests.get(appId)?.dependsOn.includes("auth") ?? false),
    );

    const configuredClients: Record<string, string[]> = {};
    for (const appId of clientApps) {
      const selected =
        rootConfig.configVersion === 1
          ? !!rootConfig.apps[appId] && rootConfig.apps[appId].enabled !== false
          : !!rootConfig.apps[appId];
      if (!selected) continue;
      const clientId = `shedflare-${appId}`;
      const deployments = [stage];
      if (stage === "prod" && rootConfig.configVersion === 2) {
        deployments.push(...Object.keys(rootConfig.apps[appId]?.productionAliases ?? {}));
      }
      const origins = deployments
        .map((deploymentStage) => Shedflare.appStackConfig(rootConfig, appId, deploymentStage))
        .filter((app) => app.authStage === stage)
        .map((app) => app.url);
      if (origins.length > 0) configuredClients[clientId] = [...new Set(origins)];
    }
    const allowedClients = mergeAdditionalAllowedClients(
      configuredClients,
      Shedflare.optionalVar(config, "ADDITIONAL_ALLOWED_CLIENTS", "{}"),
    );

    const storage = yield* Cloudflare.KV.Namespace("AuthStorage", {
      title: Shedflare.physicalName(stage, "auth", "storage"),
    });

    const database = yield* Cloudflare.D1.Database("AuthDatabase", {
      name: Shedflare.physicalName(stage, "auth", "db"),
      migrationsDir: "apps/auth/src/migrations",
    });

    const worker = yield* Cloudflare.Worker("AuthWorker", {
      name: Shedflare.physicalName(stage, "auth"),
      main: "apps/auth/src/worker.ts",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        OPENAUTH_STORAGE: storage,
        AUTH_DB: database,
        APP_PUBLIC_URL: config.url,
        GOOGLE_CLIENT_ID: Shedflare.requireVar(config, "GOOGLE_CLIENT_ID"),
        OWNER_EMAIL: config.ownerEmail,
        ALLOWED_CLIENTS: JSON.stringify(allowedClients),
        CLOUDFLARE_ACCOUNT_ID: Shedflare.optionalVar(config, "CLOUDFLARE_ACCOUNT_ID"),
      },
      crons: ["0 3 * * *"],
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    const deploymentToken = yield* Shedflare.optionalSecretConfig("DEPLOYMENTS_CF_API_TOKEN");
    const secretProps: Shedflare.WorkerSecretProps = {
      workerName: worker.workerName,
      binding: "DEPLOYMENTS_CF_API_TOKEN",
      required: false,
    };
    if (Option.isSome(deploymentToken)) secretProps.value = deploymentToken.value;
    yield* Shedflare.WorkerSecret("DeploymentReadToken", secretProps);

    return {
      app: "auth" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      kvNamespaceId: storage.namespaceId,
      databaseId: database.databaseId,
    };
  }),
);

export default AuthStack;
