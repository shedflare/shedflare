import { expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import * as s from "../../db/schema";
import { createAccount, createCategory, createTransaction } from "../../domain/factories";
import { TransactionsResponseSchema } from "../../domain/schemas-client";
import { createRouter } from "../router";

test("category activity REST filters retain only the selected category and month, including splits", async () => {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  const account = createAccount({ name: "Everyday" });
  const food = createCategory({ name: "Food", groupId: null });
  const ai = createCategory({ name: "AI", groupId: null });
  await db.insert(s.accounts).values(account);
  await db.insert(s.categories).values([food, ai]);
  const base = { accountId: account.id, date: "2026-10-06" };
  const foodTransaction = createTransaction({ ...base, categoryId: food.id, amount: -100 });
  const parent = createTransaction({ ...base, amount: -300, isParent: true });
  const child = createTransaction({
    ...base,
    categoryId: food.id,
    amount: -200,
    isChild: true,
    parentId: parent.id,
  });
  await db.insert(s.transactions).values([
    foodTransaction,
    parent,
    child,
    createTransaction({
      ...base,
      categoryId: ai.id,
      amount: -100,
      isChild: true,
      parentId: parent.id,
    }),
    createTransaction({ ...base, categoryId: ai.id, amount: -400 }),
    createTransaction({ ...base, categoryId: food.id, amount: -500, date: "2026-09-30" }),
    createTransaction({ ...base, categoryId: food.id, amount: -500, date: "2026-11-01" }),
  ]);
  const router = createRouter({
    ...env,
    // SAFETY: The SQLite shim implements the D1 methods exercised by these REST reads.
    MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
    // SAFETY: Uploads are not accessed by transaction reads.
    UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
  });
  const conditions = [
    { field: "category", op: "is", value: food.id },
    { field: "date", op: "gte", value: "2026-10-01" },
    { field: "date", op: "lte", value: "2026-10-31" },
  ];
  const params = new URLSearchParams({ conditions: JSON.stringify(conditions) });
  for (const path of ["/api/transactions", `/api/accounts/${account.id}/transactions`]) {
    const response = await router.fetch(new Request(`http://localhost${path}?${params}`));
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(TransactionsResponseSchema)(await response.json());
    expect(result.transactions.map((row) => row.id).sort()).toEqual(
      [foodTransaction.id, child.id].sort(),
    );
    expect(result.transactions.map((row) => row.categoryId)).toEqual([food.id, food.id]);
    const invalid = new URLSearchParams({
      conditions: JSON.stringify([{ field: "amount", op: "gte", value: "invalid" }]),
    });
    const rejected = await router.fetch(new Request(`http://localhost${path}?${invalid}`));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "Invalid transaction filter" });
  }
});
