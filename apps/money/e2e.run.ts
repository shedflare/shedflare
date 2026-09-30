import AuthStack from "@shedflare/auth/stack";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import { loadShedflareConfig } from "@shedflare/alchemy";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MoneyStack from "./alchemy.run";

const moneyRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moneyRoot, "../..");
process.chdir(repositoryRoot);

const stage =
  process.env.SHEDFLARE_MONEY_E2E_STAGE ??
  `e2e-money-${process.env.GITHUB_RUN_ID ?? process.env.CI_JOB_ID ?? Date.now()}`;
if (!stage.startsWith("e2e-")) throw new Error("Browser E2E requires an isolated e2e- stage");
const authEmail = process.env.SHEDFLARE_MONEY_E2E_AUTH_EMAIL ?? loadShedflareConfig().ownerEmail;
const authToken = process.env.SHEDFLARE_MONEY_E2E_AUTH_TOKEN ?? crypto.randomUUID();

process.env.SHEDFLARE_MONEY_E2E_AUTH_EMAIL = authEmail;
process.env.SHEDFLARE_MONEY_E2E_AUTH_TOKEN = authToken;

const options = {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
};

async function deployMoney() {
  await Core.run(Core.deploy(options, AuthStack, { stage }), options);
  return await Core.run(Core.deploy(options, MoneyStack, { stage }), options);
}

async function destroyMoney() {
  try {
    await Core.run(Core.destroy(options, MoneyStack, { stage }), options);
  } finally {
    await Core.run(Core.destroy(options, AuthStack, { stage }), options);
  }
}

function runPlaywright(baseUrl: string) {
  const extraArgs = process.argv
    .slice(2)
    .filter((argument) => argument !== "--destroy-only" && argument !== "--");
  execFileSync("vp", ["exec", "playwright", "test", ...extraArgs], {
    cwd: moneyRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      E2E_AUTH_EMAIL: authEmail,
      E2E_AUTH_TOKEN: authToken,
    },
  });
}

async function main() {
  if (process.argv.includes("--destroy-only")) {
    console.log(`Destroying money E2E stage ${stage}`);
    await destroyMoney();
    return;
  }

  console.log(`Deploying money E2E stage ${stage}`);
  let deployed: Awaited<ReturnType<typeof deployMoney>> | null = null;
  try {
    deployed = await deployMoney();
    if (!deployed?.url) {
      throw new Error("Money deploy returned no URL");
    }
    console.log(`Testing ${deployed.url}`);
    runPlaywright(deployed.url);
    console.log("Money E2E passed");
  } finally {
    console.log(`Destroying money E2E stage ${stage}`);
    await destroyMoney();
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
