import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const ShortStack = Alchemy.Stack(
  "ShedflareS",
  {
    providers: Shedflare.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("s");

    const db = yield* Cloudflare.D1.Database("DB", {
      name: Shedflare.physicalName(stage, "s"),
      migrationsDir: "apps/s/src/migrations",
    });

    const worker = yield* Cloudflare.Worker("SWorker", {
      name: Shedflare.physicalName(stage, "s"),
      main: "apps/s/src/worker.ts",
      assets: "apps/s/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        DB: db,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("s"),
        AUTH_CLIENT_ID: `shedflare-s`,
        OWNER_EMAIL: config.ownerEmail,
      },
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    yield* Shedflare.bindAuth(worker, "s");

    return {
      app: "s" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      dbId: db.databaseId,
    };
  }),
);

export default ShortStack;
