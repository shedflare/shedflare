import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** Resolve an operator secret through Alchemy's environment/config provider, if set. */
export function optionalSecretConfig(
  name: string,
): Config.Config<Option.Option<Redacted.Redacted<string>>> {
  return Config.option(Config.redacted(name)).pipe(
    Config.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
  );
}
