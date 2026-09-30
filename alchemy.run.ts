import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AnkiStack } from "./apps/anki/alchemy.run.ts";
import { AuthStack } from "./apps/auth/alchemy.run.ts";
import { CfBillStack } from "./apps/cf-bill/alchemy.run.ts";
import { ChatStack } from "./apps/chat/alchemy.run.ts";
import { DiscordStack } from "./apps/discord/alchemy.run.ts";
import { MoneyStack } from "./apps/money/alchemy.run.ts";
import { ObservabilityStack } from "./apps/observability/alchemy.run.ts";
import { RoutinesStack } from "./apps/routines/alchemy.run.ts";
import { ShortStack } from "./apps/s/alchemy.run.ts";
import { HomepageStack } from "./apps/homepage/alchemy.run.ts";
import { SiteStack } from "./site/alchemy.run.ts";
import * as Shedflare from "./packages/shedflare-alchemy/src/index.ts";

function whenSelected<A, E, R>(
  selected: ReadonlySet<Shedflare.AppId>,
  appId: Shedflare.AppId,
  stack: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> {
  return selected.has(appId) ? Effect.map(stack, Option.some) : Effect.succeed(Option.none());
}

function patchTailConsumers(
  credentials: Shedflare.CfCredentials,
  accountId: string,
  scriptName: string,
  service: string,
) {
  return Effect.tryPromise(() => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(Shedflare.cfAuthHeaders(credentials))) {
      if (value) headers.set(name, value);
    }
    headers.set("Content-Type", "application/json");
    return fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/script-settings`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ tail_consumers: [{ service }] }),
      },
    ).then((r) => r.json());
  });
}

export default Alchemy.Stack(
  "Shedflare",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const credentials = yield* yield* CloudflareEnvironment;
    const { accountId } = credentials;
    const rootConfig = Shedflare.loadShedflareConfig();
    const selectedApps = Shedflare.selectedAppIds(rootConfig)
      .filter(Shedflare.isAppId)
      .filter((appId) => appId !== "drive");
    const selected = new Set(selectedApps);
    const catalog = Shedflare.discoverManifests(Shedflare.findRepoRoot());
    if (
      selectedApps.some(
        (appId) => Shedflare.resolveDeploymentStage(rootConfig, catalog, appId, stage) !== stage,
      )
    ) {
      throw new Error(
        "Legacy production stages require individual app deployments to preserve ownership.",
      );
    }

    // App stacks bind AUTH to their configured Worker by physical name. The RPC
    // cutover requires deploying Auth before its consuming apps.
    const auth = yield* whenSelected(selected, "auth", AuthStack);
    const anki = yield* whenSelected(selected, "anki", AnkiStack);
    const cfBill = yield* whenSelected(selected, "cf-bill", CfBillStack);
    const chat = yield* whenSelected(selected, "chat", ChatStack);
    const discord = yield* whenSelected(selected, "discord", DiscordStack);
    const money = yield* whenSelected(selected, "money", MoneyStack);
    const short = yield* whenSelected(selected, "s", ShortStack);
    const routines = yield* whenSelected(selected, "routines", RoutinesStack);
    const homepage = yield* whenSelected(selected, "homepage", HomepageStack);
    const observability = yield* whenSelected(selected, "observability", ObservabilityStack);
    const site = yield* SiteStack;

    if (Option.isSome(observability)) {
      const obsWorker = Shedflare.physicalName(stage, "observability");
      const apps = [...selectedApps.filter((appId) => appId !== "observability"), "site"] as const;
      for (const app of apps) {
        yield* patchTailConsumers(
          credentials,
          accountId,
          Shedflare.physicalName(stage, app),
          obsWorker,
        ).pipe(
          Effect.catch((err) =>
            Effect.sync(() =>
              console.error(`[observability] failed to wire tail consumer for ${app}`, err),
            ),
          ),
        );
      }
    } else {
      yield* Effect.sync(() =>
        console.warn("[shedflare] observability app not enabled; tail consumers skipped"),
      );
    }

    return {
      stage,
      authUrl: Option.isSome(auth) ? auth.value.output.url : undefined,
      ankiUrl: Option.isSome(anki) ? anki.value.output.url : undefined,
      homepageUrl: Option.isSome(homepage) ? homepage.value.output.url : undefined,
      cfBillUrl: Option.isSome(cfBill) ? cfBill.value.output.url : undefined,
      chatUrl: Option.isSome(chat) ? chat.value.output.url : undefined,
      discordUrl: Option.isSome(discord) ? discord.value.output.url : undefined,
      moneyUrl: Option.isSome(money) ? money.value.output.url : undefined,
      shortUrl: Option.isSome(short) ? short.value.output.url : undefined,
      routinesUrl: Option.isSome(routines) ? routines.value.output.url : undefined,
      siteUrl: site.output.url,
      observabilityUrl: Option.isSome(observability) ? observability.value.output.url : undefined,
    };
  }),
);
