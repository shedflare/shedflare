/**
 * @deprecated Import from `@shedflare/alchemy` instead. Kept for gradual migration.
 */
export {
  type AppId,
  appConfig,
  appStackConfig,
  loadShedflareConfig,
  optionalSecretConfig,
  optionalVar,
  physicalName,
  requireVar,
} from "../packages/shedflare-alchemy/src/index.ts";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** @deprecated Use WorkerSecret resources instead of Worker env secrets. */
export function secretEnv(name: string): Effect.Effect<Redacted.Redacted<string>, Error> {
  return Config.redacted(name).pipe(
    Effect.mapError(
      () => new Error(`Missing secret ${name}. Set it in the environment for deploy.`),
    ),
  );
}

/** @deprecated Use WorkerSecret with required: false instead. */
export function optionalSecretEnv(
  name: string,
  fallback = "",
): Config.Config<Redacted.Redacted<string>> {
  return Config.redacted(name).pipe(Config.withDefault(Redacted.make(fallback)));
}

/** @deprecated Use optionalVar from config file. */
export function optionalEnv(name: string, fallback = ""): Config.Config<string> {
  return Config.string(name).pipe(Config.withDefault(fallback));
}

/** @deprecated Use requireVar with appConfig. */
export function requireEnv(name: string): Effect.Effect<string, Error> {
  return Config.string(name).pipe(
    Effect.mapError(
      () => new Error(`Missing env var ${name}. Set it for deploy or in shedflare.config.jsonc.`),
    ),
  );
}
