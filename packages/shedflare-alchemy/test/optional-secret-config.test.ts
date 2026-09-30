import { describe, expect, test } from "vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { optionalSecretConfig } from "../src/optional-secret-config.ts";

describe("optional deployment secrets", () => {
  test("reads Alchemy's dotenv provider without requiring process.env mutation", () => {
    const provider = ConfigProvider.orElse(
      ConfigProvider.fromDotEnvContents("DEPLOYMENTS_CF_API_TOKEN=file-token"),
      ConfigProvider.fromEnv({ env: { DEPLOYMENTS_CF_API_TOKEN: "environment-token" } }),
    );
    const secret = Effect.runSync(optionalSecretConfig("DEPLOYMENTS_CF_API_TOKEN").parse(provider));

    expect(Option.map(secret, Redacted.value)).toEqual(Option.some("file-token"));
    expect(JSON.stringify(secret)).not.toContain("file-token");
  });

  test.each(["", "DEPLOYMENTS_CF_API_TOKEN="])(
    "treats missing or empty dotenv placeholders as unset: %s",
    (contents) => {
      const provider = ConfigProvider.fromDotEnvContents(contents);
      expect(
        Effect.runSync(optionalSecretConfig("DEPLOYMENTS_CF_API_TOKEN").parse(provider)),
      ).toEqual(Option.none());
    },
  );

  test("falls back to exported configuration when the dotenv file omits the secret", () => {
    const provider = ConfigProvider.orElse(
      ConfigProvider.fromDotEnvContents("UNRELATED=value"),
      ConfigProvider.fromEnv({ env: { DEPLOYMENTS_CF_API_TOKEN: "environment-token" } }),
    );
    const secret = Effect.runSync(optionalSecretConfig("DEPLOYMENTS_CF_API_TOKEN").parse(provider));
    expect(Option.map(secret, Redacted.value)).toEqual(Option.some("environment-token"));
  });
});
