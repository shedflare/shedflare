import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  CoreError,
  createManifestCatalog,
  isAppSelected,
  loadConfig,
  migrateConfig,
  patchConfig,
  parseManifest,
  resolveAppConfig,
  resolveDeploymentStage,
  selectedAppIds,
  validateConfig,
  writeConfigMigration,
} from "../src/index.ts";

function manifest(
  id: string,
  options: {
    dependsOn?: readonly string[];
    vars?: Record<string, { from: "user"; description: string; default?: string }>;
  } = {},
) {
  return parseManifest(
    {
      id,
      name: `Shedflare ${id}`,
      description: `Description for ${id}`,
      lifecycle: "experimental",
      category: "productivity",
      dataSensitivity: "personal",
      dependsOn: options.dependsOn ?? [],
      defaultSubdomain: id,
      vars: options.vars ?? {},
      secrets: {},
      resources: [],
    },
    `fixture:${id}`,
  );
}

const catalog = createManifestCatalog([
  { manifest: manifest("auth"), source: "fixture:auth" },
  {
    manifest: manifest("chat", {
      dependsOn: ["auth"],
      vars: {
        DEFAULT_MODEL_ID: {
          from: "user",
          description: "Default model",
          default: "auto",
        },
      },
    }),
    source: "fixture:chat",
  },
  { manifest: manifest("drive", { dependsOn: ["auth"] }), source: "fixture:drive" },
]);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "shedflare-config-"));
  temporaryRoots.push(temporaryRoot);
  return temporaryRoot;
}

const legacyConfig = {
  domain: "example.com",
  ownerEmail: "owner@example.com",
  apps: {
    auth: { enabled: true, subdomain: "auth" },
    chat: { enabled: true, subdomain: "ai" },
    drive: { enabled: false, subdomain: "drive" },
  },
  vars: {
    chat: { DEFAULT_MODEL_ID: "gpt-5" },
  },
  resources: {},
};

describe("config validation and resolution", () => {
  test("preserves legacy production hostnames while isolating unlisted stages", () => {
    const config = validateConfig(
      {
        configVersion: 2,
        domain: "example.com",
        ownerEmail: "owner@example.com",
        apps: {
          auth: {},
          chat: { productionAliases: { dev_bolt: "chat" } },
          drive: { productionAliases: { dev_bolt: "drive-dev-bolt" } },
        },
      },
      catalog,
    );
    expect(resolveAppConfig(config, catalog, "chat", "dev_bolt")).toMatchObject({
      url: "https://chat.example.com",
      authStage: "prod",
    });
    expect(resolveDeploymentStage(config, catalog, "chat")).toBe("dev_bolt");
    expect(resolveDeploymentStage(config, catalog, "drive")).toBe("prod");
    expect(resolveAppConfig(config, catalog, "drive", "dev_bolt")).toMatchObject({
      url: "https://drive-dev-bolt.example.com",
      authStage: "prod",
    });
    for (const stage of ["e2e-proof", "auth-cutover-proof", "dev_other"]) {
      expect(resolveAppConfig(config, catalog, "chat", stage)).toMatchObject({
        url: `https://chat-${stage.replaceAll("_", "-")}.example.com`,
        authStage: stage,
      });
      expect(resolveDeploymentStage(config, catalog, "chat", stage)).toBe(stage);
    }
    expect(migrateConfig(config, catalog).config).toEqual(config);
  });

  test("rejects aliases for proof stages and Auth itself", () => {
    for (const [appId, aliases] of [
      ["chat", { "e2e-proof": "chat" }],
      ["chat", { prod: "chat" }],
      ["auth", { dev_bolt: "auth" }],
    ] as const) {
      expect(() =>
        validateConfig(
          {
            configVersion: 2,
            domain: "example.com",
            ownerEmail: "owner@example.com",
            apps: { [appId]: { productionAliases: aliases } },
          },
          catalog,
        ),
      ).toThrow(CoreError);
    }
  });
  test("keeps version 1 readable without mutating the input", () => {
    const input = structuredClone(legacyConfig);
    const config = validateConfig(input, catalog);

    expect(config.configVersion).toBe(1);
    expect(input).toEqual(legacyConfig);
    expect(resolveAppConfig(config, catalog, "chat", "dev-bolt")).toMatchObject({
      configuredSubdomain: "ai",
      stageSubdomain: "ai-dev-bolt",
      url: "https://ai-dev-bolt.example.com",
      vars: { DEFAULT_MODEL_ID: "gpt-5" },
    });
  });

  test("resolves sparse version 2 app defaults", () => {
    const config = validateConfig(
      {
        configVersion: 2,
        domain: "example.com",
        ownerEmail: "owner@example.com",
        apps: { chat: {}, drive: {} },
      },
      catalog,
    );

    expect(resolveAppConfig(config, catalog, "chat")).toMatchObject({
      configuredSubdomain: "chat",
      stageSubdomain: "chat",
      vars: { DEFAULT_MODEL_ID: "auto" },
    });
    expect(selectedAppIds(config)).toEqual(["chat", "drive"]);
    expect(isAppSelected(config, "money")).toBe(false);
  });

  test("excludes disabled legacy apps from deployment selection", () => {
    const config = validateConfig(legacyConfig, catalog);

    expect(selectedAppIds(config)).toEqual(["auth", "chat"]);
    expect(isAppSelected(config, "drive")).toBe(false);
  });

  test("rejects future versions, unknown apps, and unknown fields", () => {
    for (const input of [
      { ...legacyConfig, configVersion: 3 },
      { ...legacyConfig, apps: { unknown: { enabled: true, subdomain: "unknown" } } },
      { ...legacyConfig, ignored: true },
    ]) {
      expect(() => validateConfig(input, catalog)).toThrow(CoreError);
    }
  });
});

describe("config migration", () => {
  test("migrates selected version 1 apps deterministically to sparse version 2", () => {
    const config = validateConfig(legacyConfig, catalog);
    const migration = migrateConfig(config, catalog);

    expect(migration).toMatchObject({ oldVersion: 1, canWrite: true, warnings: [] });
    expect(migration.config).toEqual({
      $schema: "https://shedflare.dev/schemas/shedflare-config.schema.json",
      configVersion: 2,
      domain: "example.com",
      ownerEmail: "owner@example.com",
      apps: {
        auth: {},
        chat: { subdomain: "ai", vars: { DEFAULT_MODEL_ID: "gpt-5" } },
      },
    });
    expect(migrateConfig(migration.config, catalog).config).toEqual(migration.config);
  });

  test("blocks writes that would discard nonempty legacy resource state", () => {
    const config = validateConfig(
      { ...legacyConfig, resources: { chat: { BUCKET: "shedflare-chat" } } },
      catalog,
    );
    const migration = migrateConfig(config, catalog);

    expect(migration.canWrite).toBe(false);
    expect(migration.warnings[0]?.code).toBe("LEGACY_RESOURCES_PRESENT");
    expect(() => writeConfigMigration(migration, catalog)).toThrow("will not be discarded");
  });

  test("writes an explicit migration atomically with a local backup", () => {
    const tempRoot = temporaryRoot();
    const path = join(tempRoot, "shedflare.config.jsonc");
    const source = `${JSON.stringify(legacyConfig, null, 2)}\n`;
    writeFileSync(path, source);
    const migration = migrateConfig(validateConfig(legacyConfig, catalog), catalog, path, source);

    writeConfigMigration(migration, catalog);

    expect(loadConfig(tempRoot, catalog)).toEqual(migration.config);
    const backups = readdirSync(tempRoot).filter((file) => file.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tempRoot, backups[0]), "utf8")).toBe(source);
  });
});

describe("comment-preserving patches", () => {
  test("keeps production aliases through unrelated edits and removes them explicitly", () => {
    const tempRoot = temporaryRoot();
    const path = join(tempRoot, "shedflare.config.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        configVersion: 2,
        domain: "example.com",
        ownerEmail: "owner@example.com",
        apps: { chat: {} },
      }),
    );
    patchConfig(tempRoot, { apps: { chat: { productionAliases: { dev_bolt: "chat" } } } }, catalog);
    const config = patchConfig(
      tempRoot,
      { apps: { chat: { vars: { DEFAULT_MODEL_ID: "test" } } } },
      catalog,
    );
    expect(config.apps.chat.productionAliases).toEqual({ dev_bolt: "chat" });
    expect(loadConfig(tempRoot, catalog)).toEqual(config);
    const removed = patchConfig(tempRoot, { apps: { chat: { productionAliases: null } } }, catalog);
    expect(removed.apps.chat.productionAliases).toBeUndefined();
    expect(resolveDeploymentStage(removed, catalog, "chat")).toBe("prod");
  });
  test("preserves comments while applying a sparse config update", () => {
    const tempRoot = temporaryRoot();
    const path = join(tempRoot, "shedflare.config.jsonc");
    writeFileSync(
      path,
      `{
  // The deployment domain stays documented.
  "configVersion": 2,
  "domain": "example.com",
  "ownerEmail": "owner@example.com",
  "apps": {
    // Chat is selected for daily use.
    "chat": {
      "vars": {
        "DEFAULT_MODEL_ID": "auto"
      }
    }
  }
}
`,
    );

    const config = patchConfig(
      tempRoot,
      { apps: { chat: { subdomain: "ai", vars: { DEFAULT_MODEL_ID: "gpt-5" } } } },
      catalog,
    );
    const result = readFileSync(path, "utf8");

    expect(config.apps.chat).toEqual({
      subdomain: "ai",
      vars: { DEFAULT_MODEL_ID: "gpt-5" },
    });
    expect(result).toContain("// The deployment domain stays documented.");
    expect(result).toContain("// Chat is selected for daily use.");
  });
});
