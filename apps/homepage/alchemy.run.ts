import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const HomepageStack = Alchemy.Stack(
  "ShedflareHomepage",
  {
    providers: Shedflare.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("homepage");

    const db = yield* Cloudflare.D1.Database("DB", {
      name: Shedflare.physicalName(stage, "homepage"),
      migrationsDir: "apps/homepage/src/migrations",
    });

    const images = yield* Cloudflare.R2.Bucket("IMAGES", {
      name: Shedflare.physicalName(stage, "homepage", "images"),
    });

    const worker = yield* Cloudflare.Worker("HomepageWorker", {
      name: Shedflare.physicalName(stage, "homepage"),
      main: "apps/homepage/src/worker.ts",
      assets: "apps/homepage/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        DB: db,
        IMAGES: images,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("homepage"),
        AUTH_CLIENT_ID: `shedflare-homepage`,
        OWNER_EMAIL: config.ownerEmail,
      },
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    yield* Shedflare.bindAuth(worker, "homepage");

    return {
      app: "homepage" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      bucketName: images.bucketName,
      dbId: db.databaseId,
    };
  }),
);

export default HomepageStack;
