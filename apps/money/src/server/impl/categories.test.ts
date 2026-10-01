import { expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "../command-handlers/handle-command";
import { createRouter } from "../router";
import { CategoriesResponseSchema, TransactionsResponseSchema } from "../../domain/schemas-client";
import type { CommandInvocation } from "../../domain/commands";

test("the REST client receives distinct category, group, and account names", async () => {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  async function create(invocation: CommandInvocation) {
    const result = await handleCommand(db, invocation);
    if (!result.ok || !result.data.id) throw new Error("Fixture creation failed");
    return result.data.id;
  }
  const groupId = await create({
    commandType: "create_category_group",
    payload: { name: "Everyday" },
  });
  const categoryId = await create({
    commandType: "create_category",
    payload: { name: "Coffee", groupId },
  });
  await create({ commandType: "create_category", payload: { name: "Other", groupId: null } });
  const accountId = await create({ commandType: "create_account", payload: { name: "Checking" } });
  await create({
    commandType: "create_transaction",
    payload: {
      row: { accountId, categoryId, date: "2026-09-30", amount: -450, payee: "Corner cafe" },
    },
  });
  const router = createRouter({
    ...env,
    // SAFETY: The SQLite shim implements the D1 methods exercised by these REST reads.
    MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
    // SAFETY: Uploads are not accessed by the category and transaction endpoints under test.
    UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
  });
  const categoriesResponse = await router.fetch(new Request("http://localhost/api/categories"));
  expect(categoriesResponse.status).toBe(200);
  const categories = Schema.decodeUnknownSync(CategoriesResponseSchema)(
    await categoriesResponse.json(),
  );
  expect(categories.categories.find((category) => category.id === categoryId)).toMatchObject({
    name: "Coffee",
    group_name: "Everyday",
  });
  expect(
    categories.categories.find((category) => category.name === "Other")?.group_name,
  ).toBeNull();
  const activityResponse = await router.fetch(new Request("http://localhost/api/transactions"));
  expect(activityResponse.status).toBe(200);
  const activity = Schema.decodeUnknownSync(TransactionsResponseSchema)(
    await activityResponse.json(),
  );
  expect(activity.transactions[0]).toMatchObject({
    categoryName: "Coffee",
    accountName: "Checking",
    scheduleName: null,
  });
});
