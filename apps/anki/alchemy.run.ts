import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";

export const AnkiStack = Alchemy.Stack(
  "ShedflareAnki",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("anki");

    const db = yield* Cloudflare.D1.Database("ANKI_DB", {
      name: Shedflare.physicalName(stage, "anki"),
      migrationsDir: "apps/anki/drizzle/migrations",
    });

    const worker = yield* Cloudflare.Worker("AnkiWorker", {
      name: Shedflare.physicalName(stage, "anki"),
      main: "apps/anki/src/worker.ts",
      assets: "apps/anki/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        DB: db,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("anki"),
        AUTH_CLIENT_ID: `shedflare-anki`,
        OWNER_EMAIL: config.ownerEmail,
      },
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    yield* Shedflare.bindAuth(worker, "anki");

    return {
      app: "anki" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      dbId: db.databaseId,
    };
  }),
);

export default AnkiStack;
