import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Shedflare from "@shedflare/alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const ChatStack = Alchemy.Stack(
  "ShedflareChat",
  {
    providers: Shedflare.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const config = yield* Shedflare.appConfig("chat");

    const uploads = yield* Cloudflare.R2.Bucket("UPLOADS", {
      name: Shedflare.physicalName(stage, "chat", "uploads"),
    });

    const syncEngine = Cloudflare.Workers.DurableObject<unknown>("SYNC_ENGINE", {
      className: "SyncEngineDurableObject",
    });

    const worker = yield* Cloudflare.Worker("ChatWorker", {
      name: Shedflare.physicalName(stage, "chat"),
      main: "apps/chat/src/worker.ts",
      assets: "apps/chat/dist",
      compatibility: {
        date: "2026-03-22",
        flags: ["nodejs_compat"],
      },
      crons: ["0 3 * * SUN"],
      env: {
        UPLOADS: uploads,
        SYNC_ENGINE: syncEngine,
        APP_PUBLIC_URL: config.url,
        AUTH_URL: yield* Shedflare.authUrl("chat"),
        AUTH_CLIENT_ID: `shedflare-chat`,
        OWNER_EMAIL: config.ownerEmail,
        DEFAULT_MODEL_ID: Shedflare.optionalVar(config, "DEFAULT_MODEL_ID", "auto"),
      },
      domain: config.url.startsWith("https://") ? new URL(config.url).hostname : undefined,
    });

    const uploadToken = yield* Alchemy.Random("UPLOAD_TOKEN_SECRET");
    const opencodeKey = yield* Shedflare.optionalSecretConfig("OPENCODE_GO_API_KEY");
    const exaKey = yield* Shedflare.optionalSecretConfig("EXA_API_KEY");

    if (Option.isSome(opencodeKey)) {
      yield* Shedflare.WorkerSecret("OpencodeKey", {
        workerName: worker.workerName,
        binding: "OPENCODE_GO_API_KEY",
        value: opencodeKey.value,
        required: true,
      });
    } else {
      yield* Shedflare.WorkerSecret("OpencodeKey", {
        workerName: worker.workerName,
        binding: "OPENCODE_GO_API_KEY",
        required: true,
      });
    }

    yield* Shedflare.WorkerSecret("UploadToken", {
      workerName: worker.workerName,
      binding: "UPLOAD_TOKEN_SECRET",
      value: uploadToken.text,
    });

    if (Option.isSome(exaKey)) {
      yield* Shedflare.WorkerSecret("ExaKey", {
        workerName: worker.workerName,
        binding: "EXA_API_KEY",
        value: exaKey.value,
        required: false,
      });
    } else {
      yield* Shedflare.WorkerSecret("ExaKey", {
        workerName: worker.workerName,
        binding: "EXA_API_KEY",
        required: false,
      });
    }

    yield* Shedflare.bindAuth(worker, "chat");

    return {
      app: "chat" as const,
      url: worker.url ?? config.url,
      configuredUrl: config.url,
      workerName: worker.workerName,
      bucketName: uploads.bucketName,
    };
  }),
);

export default ChatStack;
