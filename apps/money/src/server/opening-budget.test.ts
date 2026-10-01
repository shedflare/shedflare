import { expect, test } from "vite-plus/test";
import * as s from "../db/schema";
import { createAccount, createCategory } from "../domain/factories";
import { createMoneyTestEnv, dbFor } from "../test/helpers";
import { computeMonthBudget } from "./budget-engine";
import { computeMonthlyReport } from "./monthly-report";
test("opening balances fund the account's creation month once, excluding off-budget accounts and income reports", async () => {
  const db = dbFor(createMoneyTestEnv());
  const opened = "2026-10-01T12:00:00.000Z";
  await db.insert(s.accounts).values([
    { ...createAccount({ name: "Everyday", balance: 500_000_000 }), createdAt: opened },
    {
      ...createAccount({ name: "Savings", balance: 4_200_000_000, offBudget: true }),
      createdAt: opened,
    },
    {
      ...createAccount({ name: "Old account", balance: 100_000_000 }),
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    { ...createAccount({ name: "Debt", balance: -50_000_000 }), createdAt: opened },
  ]);
  const category = createCategory({ name: "Food", groupId: null });
  await db.insert(s.categories).values(category);
  expect((await computeMonthBudget(db, 202610))?.toBudget).toBe(450_000_000);
  expect((await computeMonthBudget(db, 202611))?.toBudget).toBe(0);
  expect((await computeMonthBudget(db, 202609))?.toBudget).toBe(100_000_000);
  const report = await computeMonthlyReport(db, "2026-10");
  expect(report.income).toBe(0);
  expect(report.expense).toBe(0);
  await db.insert(s.budgets).values({
    id: `202610-${category.id}`,
    month: 202610,
    categoryId: category.id,
    amount: 125_000_000,
    carryover: false,
    createdAt: opened,
    updatedAt: opened,
  });
  expect((await computeMonthBudget(db, 202610))?.toBudget).toBe(325_000_000);
});
