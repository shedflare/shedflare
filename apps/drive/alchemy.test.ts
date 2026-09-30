import AuthStack from "@shedflare/auth/stack";
import { make } from "alchemy/Test/Vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import assert from "node:assert/strict";
import DriveStack from "./alchemy.run";

const live = process.env.SHEDFLARE_LIVE_ALCHEMY_TESTS === "1";

const { test, afterAll, deploy, destroy } = make({
  providers: Cloudflare.providers(),
});

afterAll(
  live
    ? destroy(DriveStack).pipe(Effect.ensuring(destroy(AuthStack).pipe(Effect.orDie)))
    : Effect.void,
);

test.skipIf(!live)(
  "drive endpoints respond correctly",
  Effect.gen(function* () {
    yield* deploy(AuthStack);
    const deployed = yield* deploy(DriveStack);
    assert.ok(deployed.url);
    const base = deployed.url;
    const root = yield* Effect.promise(() => fetch(base));
    assert.equal(root.status, 200);

    const login = yield* Effect.promise(() =>
      fetch(`${base}/api/auth/login`, { redirect: "manual" }),
    );
    assert.equal(login.status, 302);

    const files = yield* Effect.promise(() => fetch(`${base}/api/files`));
    assert.equal(files.status, 401);

    const tags = yield* Effect.promise(() => fetch(`${base}/api/tags`));
    assert.equal(tags.status, 401);

    const session = yield* Effect.promise(() => fetch(`${base}/api/session`));
    assert.equal(session.status, 401);
  }),
  { timeout: 120_000 },
);
