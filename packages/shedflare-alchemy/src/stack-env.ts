import * as Effect from "effect/Effect";
import * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { physicalName } from "./physical-name.ts";
import { discoverManifests, findRepoRoot, resolveDeploymentStage } from "@shedflare/core";
import {
  appStackConfig,
  loadShedflareConfig,
  optionalVar,
  requireVar,
  type AppId,
  type AppStackConfig,
} from "./config.ts";

export type { AppId, AppStackConfig };

export function appConfig(appId: AppId) {
  return Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const rootConfig = loadShedflareConfig();
    const deploymentStage = resolveDeploymentStage(
      rootConfig,
      discoverManifests(findRepoRoot()),
      appId,
      stage,
    );
    if (deploymentStage !== stage) {
      throw new Error(
        `${appId} production is owned by stage ${deploymentStage}. Use --stage ${deploymentStage} to preserve its resources.`,
      );
    }
    return appStackConfig(rootConfig, appId, stage);
  });
}

export function authUrl(appId: AppId) {
  return Effect.map(
    appConfig(appId),
    (config) => appStackConfig(loadShedflareConfig(), "auth", config.authStage).url,
  );
}

/** Preserve legacy production ownership; every other stage gets its own Auth. */
export function bindAuth(worker: Cloudflare.Worker, appId: AppId) {
  return Effect.gen(function* () {
    const config = yield* appConfig(appId);
    yield* worker.bind`auth`({
      bindings: [
        { type: "service", name: "AUTH", service: physicalName(config.authStage, "auth") },
      ],
    });
  });
}

export { requireVar, optionalVar };
