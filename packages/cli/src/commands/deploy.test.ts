import { describe, expect, test } from "vite-plus/test";
import { alchemyDeployArgs } from "./deploy.js";

describe("alchemy deploy arguments", () => {
  test("omits --env-file when the repository has no .env", () => {
    const args = alchemyDeployArgs({ target: "alchemy.run.ts", stage: "prod" });

    expect(args).toEqual([
      "exec",
      "alchemy",
      "deploy",
      "alchemy.run.ts",
      "--stage",
      "prod",
      "--yes",
    ]);
    expect(args).not.toContain("--env-file");
  });

  test("passes the repository .env so Alchemy does not depend on the caller's cwd", () => {
    const args = alchemyDeployArgs({
      target: "apps/money/alchemy.run.ts",
      stage: "prod",
      envFile: "/repo/.env",
    });

    expect(args).toContain("--env-file");
    expect(args[args.indexOf("--env-file") + 1]).toBe("/repo/.env");
  });

  test("forwards an explicit auth profile", () => {
    const args = alchemyDeployArgs({
      target: "apps/money/alchemy.run.ts",
      stage: "prod",
      profile: "party",
    });

    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("party");
  });

  test("omits --profile so Alchemy resolves its own default profile", () => {
    expect(alchemyDeployArgs({ target: "alchemy.run.ts", stage: "prod" })).not.toContain(
      "--profile",
    );
  });

  test("never points Alchemy at an empty environment file", () => {
    // Alchemy's loadConfigProvider skips its automatic `.env` branch whenever
    // --env-file is present, so an empty file hides the whole environment.
    const args = alchemyDeployArgs({
      target: "apps/money/alchemy.run.ts",
      stage: "prod",
      envFile: "/repo/.env",
    });
    const envFile = args[args.indexOf("--env-file") + 1];

    expect(envFile).not.toBe("");
    expect(envFile.endsWith("empty.env")).toBe(false);
  });
});
