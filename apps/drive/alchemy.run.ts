import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const DriveStack = Alchemy.Stack(
  "ShedflareDrive",
  {
    providers: Shedflare.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("drive");
    const e2eAuthEmail = process.env.SHEDFLARE_DRIVE_E2E_AUTH_EMAIL;
    const e2eAuthToken = process.env.SHEDFLARE_DRIVE_E2E_AUTH_TOKEN;
    const isE2eStage = stage.startsWith("e2e-");
    const e2eAuth = Shedflare.resolveE2eAuthBindings({
      stage,
      appId: "drive",
      email: e2eAuthEmail,
      token: e2eAuthToken,
    });

    const db = yield* Cloudflare.D1.Database("DB", {
      name: Shedflare.physicalName(stage, "drive"),
      migrationsDir: "apps/drive/src/migrations",
    });

    const filesBucket = yield* Cloudflare.R2.Bucket("FILES", {
      name: Shedflare.physicalName(stage, "drive", "files"),
    });

    const secureUploadToken = yield* Alchemy.Random("SECURE_UPLOAD_TOKEN_SECRET");

    const worker = yield* Cloudflare.Worker("DriveWorker", {
      name: Shedflare.physicalName(stage, "drive"),
      main: "apps/drive/src/worker.ts",
      assets: {
        directory: "apps/drive/dist",
        runWorkerFirst: true,
      },
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      env: {
        DB: db,
        FILES: filesBucket,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("drive"),
        AUTH_CLIENT_ID: `shedflare-drive`,
        OWNER_EMAIL: config.ownerEmail,
        ...e2eAuth,
      },
      domain:
        !isE2eStage && config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    yield* Shedflare.WorkerSecret("SecureUploadToken", {
      workerName: worker.workerName,
      binding: "SECURE_UPLOAD_TOKEN_SECRET",
      value: secureUploadToken.text,
    });

    yield* Shedflare.bindAuth(worker, "drive");

    return {
      app: "drive" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      dbId: db.databaseId,
      bucketName: filesBucket.bucketName,
    };
  }),
);

export default DriveStack;
