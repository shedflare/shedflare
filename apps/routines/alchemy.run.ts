import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";

export const RoutinesStack = Alchemy.Stack(
  "ShedflareRoutines",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("routines");

    const db = yield* Cloudflare.D1.Database("DB", {
      name: Shedflare.physicalName(stage, "routines"),
      migrationsDir: "apps/routines/src/migrations",
    });

    const worker = yield* Cloudflare.Worker("RoutinesWorker", {
      name: Shedflare.physicalName(stage, "routines"),
      main: "apps/routines/src/worker.ts",
      assets: "apps/routines/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        DB: db,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("routines"),
        AUTH_CLIENT_ID: `shedflare-routines`,
        OWNER_EMAIL: config.ownerEmail,
      },
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    yield* Shedflare.bindAuth(worker, "routines");

    return {
      app: "routines" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      dbId: db.databaseId,
    };
  }),
);

export default RoutinesStack;
