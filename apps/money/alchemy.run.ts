import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";

export const MoneyStack = Alchemy.Stack(
  "ShedflareMoney",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("money");
    const e2eAuthEmail = process.env.SHEDFLARE_MONEY_E2E_AUTH_EMAIL;
    const e2eAuthToken = process.env.SHEDFLARE_MONEY_E2E_AUTH_TOKEN;
    const isE2eStage = stage.startsWith("e2e-");
    const e2eAuth = Shedflare.resolveE2eAuthBindings({
      stage,
      appId: "money",
      email: e2eAuthEmail,
      token: e2eAuthToken,
    });

    const uploads = yield* Cloudflare.R2.Bucket("UPLOADS", {
      name: Shedflare.physicalName(stage, "money", "uploads"),
    });

    const moneyDb = yield* Cloudflare.D1.Database("MONEY_DB", {
      name: Shedflare.physicalName(stage, "money", "db"),
      migrationsDir: "apps/money/src/migrations",
    });

    const worker = yield* Cloudflare.Worker("MoneyWorker", {
      name: Shedflare.physicalName(stage, "money"),
      main: "apps/money/src/worker.ts",
      assets: "apps/money/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        UPLOADS: uploads,
        MONEY_DB: moneyDb,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("money"),
        AUTH_CLIENT_ID: `shedflare-money`,
        OWNER_EMAIL: config.ownerEmail,
        ...e2eAuth,
      },
      domain:
        !isE2eStage && config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    yield* Shedflare.bindAuth(worker, "money");

    return {
      app: "money" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      bucketName: uploads.bucketName,
    };
  }),
);

export default MoneyStack;
