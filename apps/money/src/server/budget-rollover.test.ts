import { beforeEach, describe, expect, test } from "vite-plus/test";
import * as s from "../db/schema";
import { createAccount, createCategory, createTransaction } from "../domain/factories";
import { budgetId } from "../domain/types";
import { createMoneyTestEnv, dbFor } from "../test/helpers";
import type { Db } from "./d1-access";
import { computeMonthBudget } from "./budget-engine";

const now = "2026-08-01T00:00:00.000Z";
let db: Db;
const account = { ...createAccount({ name: "Everyday" }), createdAt: now };
const salary = createCategory({ name: "Salary", groupId: null, isIncome: true });
const food = createCategory({ name: "Food", groupId: null });
const savings = createCategory({ name: "Emergency fund", groupId: null });

async function assign(month: number, categoryId: string, amount: number, carryover = false) {
  await db.insert(s.budgets).values({
    id: budgetId(month, categoryId),
    month,
    categoryId,
    amount,
    carryover,
    createdAt: now,
    updatedAt: now,
  });
}

async function record(date: string, categoryId: string, amount: number) {
  await db
    .insert(s.transactions)
    .values(createTransaction({ accountId: account.id, categoryId, amount, date }));
}

async function budget(month: number) {
  const result = await computeMonthBudget(db, month);
  if (!result) throw new Error("expected a budget");
  const leftover = (categoryId: string) =>
    result.categories.find((row) => row.categoryId === categoryId)?.leftover;
  return { ...result, leftover };
}

describe("envelope rollover", () => {
  beforeEach(async () => {
    db = dbFor(createMoneyTestEnv());
    await db.insert(s.accounts).values(account);
    await db.insert(s.categories).values([salary, food, savings]);
  });

  test("income received last month funds this month's assignments", async () => {
    await record("2026-09-25", salary.id, 9_600_000);
    await assign(202610, food.id, 2_000_000);
    await assign(202610, savings.id, 1_000_000);

    const october = await budget(202610);
    expect(october.fromLastMonth).toBe(9_600_000);
    expect(october.toBudget).toBe(6_600_000);
    // Unassigned money keeps rolling into later months.
    expect((await budget(202612)).toBudget).toBe(6_600_000);
  });

  test("category balances keep rolling forward across empty months", async () => {
    await record("2026-08-01", salary.id, 1_000_000);
    await assign(202608, savings.id, 500_000);
    await assign(202609, savings.id, 500_000);
    await assign(202608, food.id, 300_000);
    await record("2026-09-10", food.id, -100_000);

    const november = await budget(202611);
    expect(november.leftover(savings.id)).toBe(1_000_000);
    expect(november.leftover(food.id)).toBe(200_000);
    expect(november.toBudget).toBe(-300_000);
  });

  test("money held for next month comes back the following month", async () => {
    await record("2026-09-25", salary.id, 9_600_000);
    await db
      .insert(s.budgetMonths)
      .values({ id: "2026-09", buffered: 9_000_000, createdAt: now, updatedAt: now });

    const september = await budget(202609);
    expect(september.toBudget).toBe(600_000);
    expect(september.buffered).toBe(9_000_000);
    const october = await budget(202610);
    expect(october.fromLastMonth).toBe(9_600_000);
    expect(october.toBudget).toBe(9_600_000);
  });

  test("uncovered overspending comes out of next month's To assign", async () => {
    await record("2026-09-01", salary.id, 1_000_000);
    await assign(202609, food.id, 100_000);
    await record("2026-09-15", food.id, -300_000);

    const october = await budget(202610);
    expect(october.leftover(food.id)).toBe(0);
    expect(october.overspentLastMonth).toBe(200_000);
    expect(october.toBudget).toBe(700_000);
  });

  test("carryover keeps overspending in the category instead", async () => {
    await record("2026-09-01", salary.id, 1_000_000);
    await assign(202609, food.id, 100_000);
    await record("2026-09-15", food.id, -300_000);
    await assign(202610, food.id, 0, true);

    const october = await budget(202610);
    expect(october.leftover(food.id)).toBe(-200_000);
    expect(october.overspentLastMonth).toBe(0);
    expect(october.toBudget).toBe(900_000);
  });
});
