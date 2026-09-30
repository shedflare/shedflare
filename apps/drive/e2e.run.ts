import AuthStack from "@shedflare/auth/stack";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Core from "alchemy/Test/Core";
import { loadShedflareConfig } from "@shedflare/alchemy";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import DriveStack from "./alchemy.run";

const driveRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(driveRoot, "../..");
process.chdir(repositoryRoot);
const stage =
  process.env.SHEDFLARE_DRIVE_E2E_STAGE ??
  `e2e-drive-${process.env.GITHUB_RUN_ID ?? process.env.CI_JOB_ID ?? Date.now()}`;
if (!stage.startsWith("e2e-")) throw new Error("Browser E2E requires an isolated e2e- stage");
const authEmail = process.env.SHEDFLARE_DRIVE_E2E_AUTH_EMAIL ?? loadShedflareConfig().ownerEmail;
const authToken = process.env.SHEDFLARE_DRIVE_E2E_AUTH_TOKEN ?? crypto.randomUUID();

process.env.SHEDFLARE_DRIVE_E2E_AUTH_EMAIL = authEmail;
process.env.SHEDFLARE_DRIVE_E2E_AUTH_TOKEN = authToken;

const options = {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
};

async function deployDrive() {
  await Core.run(Core.deploy(options, AuthStack, { stage }), options);
  return await Core.run(Core.deploy(options, DriveStack, { stage }), options);
}

async function destroyDrive() {
  try {
    await Core.run(Core.destroy(options, DriveStack, { stage }), options);
  } finally {
    await Core.run(Core.destroy(options, AuthStack, { stage }), options);
  }
}

async function waitForDrive(baseUrl: string) {
  const deadline = Date.now() + 60_000;
  let consecutiveReadyChecks = 0;
  while (Date.now() < deadline) {
    try {
      const request = (path: string) =>
        fetch(new URL(path, baseUrl), {
          headers: { "x-shedflare-e2e-token": authToken },
          redirect: "manual",
        });
      const [root, session, files, tags] = await Promise.all([
        request("/"),
        request("/api/session"),
        request("/api/files?limit=1&offset=0"),
        request("/api/tags"),
      ]);
      const ready =
        root.status === 200 &&
        (await root.text()).includes("<title>Shedflare Drive</title>") &&
        session.status === 200 &&
        files.status === 200 &&
        tags.status === 200;
      consecutiveReadyChecks = ready ? consecutiveReadyChecks + 1 : 0;
      if (consecutiveReadyChecks >= 2) return;
    } catch {
      // A newly created workers.dev route can be briefly unavailable while it propagates.
      consecutiveReadyChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Drive did not become ready at ${baseUrl} within 60 seconds`);
}

function runPlaywright(baseUrl: string) {
  const extraArgs = process.argv
    .slice(2)
    .filter((argument) => argument !== "--destroy-only" && argument !== "--");
  execFileSync("vp", ["exec", "playwright", "test", ...extraArgs], {
    cwd: driveRoot,
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
    console.log(`Destroying drive E2E stage ${stage}`);
    await destroyDrive();
    return;
  }

  console.log(`Deploying drive E2E stage ${stage}`);
  let deployed: Awaited<ReturnType<typeof deployDrive>> | null = null;
  try {
    deployed = await deployDrive();
    const baseUrl = deployed.url ?? deployed.configuredUrl;
    console.log(`Waiting for ${baseUrl}`);
    await waitForDrive(baseUrl);
    console.log(`Testing ${baseUrl}`);
    runPlaywright(baseUrl);
    console.log("Drive E2E passed");
  } finally {
    console.log(`Destroying drive E2E stage ${stage}`);
    await destroyDrive();
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
