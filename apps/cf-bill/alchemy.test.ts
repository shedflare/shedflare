import AuthStack from "@shedflare/auth/stack";
import { make } from "alchemy/Test/Vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import assert from "node:assert/strict";
import CfBillStack from "./alchemy.run";

const live = process.env.SHEDFLARE_LIVE_ALCHEMY_TESTS === "1";

const { test, afterAll, deploy, destroy } = make({
  providers: Cloudflare.providers(),
});

afterAll(
  live
    ? destroy(CfBillStack).pipe(Effect.ensuring(destroy(AuthStack).pipe(Effect.orDie)))
    : Effect.void,
);

test.skipIf(!live)(
  "cf-bill endpoints respond correctly",
  Effect.gen(function* () {
    yield* deploy(AuthStack);
    const deployed = yield* deploy(CfBillStack);
    const base = deployed.url;
    if (!base) throw new Error("CF Bill deployment did not return a URL");
    const root = yield* Effect.promise(() => fetch(base));
    assert.equal(root.status, 200);

    const login = yield* Effect.promise(() =>
      fetch(`${base}/api/auth/login`, { redirect: "manual" }),
    );
    assert.equal(login.status, 302);

    const usage = yield* Effect.promise(() => fetch(`${base}/api/usage`));
    assert.equal(usage.status, 401);

    const session = yield* Effect.promise(() => fetch(`${base}/api/session`));
    assert.equal(session.status, 401);
  }),
  { timeout: 120_000 },
);
