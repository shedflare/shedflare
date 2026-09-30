import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const CfBillStack = Alchemy.Stack(
  "ShedflareCfBill",
  {
    providers: Shedflare.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("cf-bill");

    const worker = yield* Cloudflare.Worker("CfBillWorker", {
      name: Shedflare.physicalName(stage, "cf-bill"),
      main: "apps/cf-bill/src/worker.ts",
      assets: "apps/cf-bill/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("cf-bill"),
        AUTH_CLIENT_ID: `shedflare-cf-bill`,
        OWNER_EMAIL: config.ownerEmail,
        CLOUDFLARE_ACCOUNT_ID: Shedflare.requireVar(config, "CLOUDFLARE_ACCOUNT_ID"),
        CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID ?? "",
      },
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    const cfToken = yield* Shedflare.optionalSecretConfig("CF_API_TOKEN");

    const secretProps: Shedflare.WorkerSecretProps = {
      workerName: worker.workerName,
      binding: "CF_API_TOKEN",
      required: true,
    };
    if (Option.isSome(cfToken)) secretProps.value = cfToken.value;

    yield* Shedflare.WorkerSecret("CfApiToken", secretProps);

    yield* Shedflare.bindAuth(worker, "cf-bill");

    return {
      app: "cf-bill" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
    };
  }),
);

export default CfBillStack;
