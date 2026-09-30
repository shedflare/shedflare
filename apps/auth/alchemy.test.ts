import { make } from "alchemy/Test/Vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import assert from "node:assert/strict";
import AuthStack from "./alchemy.run";

const live = process.env.SHEDFLARE_LIVE_ALCHEMY_TESTS === "1";

const { test, afterAll, deploy, destroy } = make({
  providers: Cloudflare.providers(),
});

afterAll(live ? destroy(AuthStack) : Effect.void);

test.skipIf(!live)(
  "auth worker is reachable",
  Effect.gen(function* () {
    const deployed = yield* deploy(AuthStack);
    const base = deployed.configuredUrl;
    if (!base) throw new Error("Auth deployment did not return a URL");
    assert.ok(base);
    const response = yield* Effect.promise(() => fetch(base));
    assert.equal(response.status, 200);
    assert.match(yield* Effect.promise(() => response.text()), /Shedflare Auth/);
  }),
  { timeout: 120_000 },
);
