import { expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { readDrizzleMigrationStatements } from "@shedflare/test-utils/migrations";
import { createD1Shim } from "@shedflare/test-utils/d1-shim";
import { join } from "node:path";
import { createMoneyTestEnv } from "../../test/helpers";
import { createRouter } from "../router";
import { CategoriesResponseSchema, CommandResponseSchema } from "../../domain/schemas-client";

test("category icon migration preserves existing names, targets, and initials", async () => {
  const migrations = readDrizzleMigrationStatements(join(import.meta.dirname, "../../migrations"));
  const d1 = createD1Shim();
  const iconMigration = migrations.findIndex((statement) => statement.includes("ADD `icon`"));
  expect(iconMigration).toBeGreaterThan(0);
  for (const statement of migrations.slice(0, iconMigration)) d1.exec(statement);
  d1.exec(
    "INSERT INTO categories (id, name, goal_def, created_at, updated_at) VALUES ('cat_existing', 'Groceries', '{\"type\":\"monthly\",\"amount\":45000}', '2026-09-01', '2026-09-01')",
  );
  for (const statement of migrations.slice(iconMigration)) d1.exec(statement);
  const row = await d1
    .prepare("SELECT name, goal_def, icon FROM categories WHERE id = 'cat_existing'")
    .first();
  expect(row).toEqual({
    name: "Groceries",
    goal_def: '{"type":"monthly","amount":45000}',
    icon: null,
  });
});

test("icons persist through REST, reject unknown keys, and survive a failed save and retry", async () => {
  const env = createMoneyTestEnv();
  const router = createRouter({
    ...env,
    // SAFETY: The local SQLite shim implements all D1 methods used by these handlers.
    MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
    // SAFETY: Upload storage is not used by the category endpoints under test.
    UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
  });
  const command = (
    commandType: "create_category" | "update_category",
    payload: Record<string, string | null>,
  ) =>
    router.fetch(
      new Request("http://localhost/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandType, payload }),
      }),
    );
  const created = await command("create_category", {
    name: "Coffee",
    groupId: null,
    icon: "coffee",
  });
  expect(created.status).toBe(200);
  const result = Schema.decodeUnknownSync(CommandResponseSchema)(await created.json());
  if (!result.ok || !result.data.id) throw new Error("Category creation failed");
  const id = result.data.id;
  async function read() {
    const response = await router.fetch(new Request("http://localhost/api/categories"));
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(CategoriesResponseSchema)(
      await response.json(),
    ).categories.find((category) => category.id === id);
  }
  expect((await read())?.icon).toBe("coffee");
  expect((await command("update_category", { id, name: "Daily coffee" })).status).toBe(200);
  expect((await read())?.icon).toBe("coffee");
  expect((await command("update_category", { id, icon: "unknown-icon" })).status).toBe(400);
  expect((await read())?.icon).toBe("coffee");
  env.MONEY_DB.exec(
    "CREATE TRIGGER reject_icon BEFORE UPDATE ON categories BEGIN SELECT RAISE(ABORT, 'Cannot save icon'); END",
  );
  expect((await command("update_category", { id, icon: "basket" })).status).toBe(500);
  expect((await read())?.icon).toBe("coffee");
  env.MONEY_DB.exec("DROP TRIGGER reject_icon");
  expect((await command("update_category", { id, icon: "basket" })).status).toBe(200);
  expect((await read())?.icon).toBe("basket");
  expect((await command("update_category", { id, icon: "coffee" })).status).toBe(200);
  expect((await read())?.icon).toBe("coffee");
  expect((await command("update_category", { id, icon: null })).status).toBe(200);
  expect((await read())?.icon).toBeNull();
});
