import { describe, expect, test } from "vite-plus/test";
import { createMoneyTestEnv, dbFor } from "../test/helpers";
import * as s from "../db/schema";
import { createAccount, createCategory, createTransaction } from "../domain/factories";
import { computeMonthlyReport } from "./monthly-report";
import { monthlyReport, validReportMonth } from "../domain/monthly-report";

describe("monthly reports", () => {
  test("two-month D1 totals include refunds, hidden categories, uncategorized income, and splits once", async () => {
    const db = dbFor(createMoneyTestEnv());
    const account = createAccount({ name: "Everyday" });
    const food = createCategory({ name: "Food", groupId: null, icon: "basket" });
    const income = createCategory({ name: "Income", groupId: null, isIncome: true });
    await db.insert(s.accounts).values(account);
    await db.insert(s.categories).values([{ ...food, hidden: true }, income]);
    const base = { accountId: account.id, date: "2026-10-01" };
    const parent = createTransaction({ ...base, amount: -700, isParent: true });
    const rows = [
      createTransaction({ ...base, categoryId: income.id, amount: 3_500_000_000 }),
      createTransaction({ ...base, categoryId: income.id, amount: -100 }),
      createTransaction({ ...base, categoryId: food.id, amount: -1000 }),
      createTransaction({ ...base, categoryId: food.id, amount: 200 }),
      createTransaction({ ...base, amount: -300 }),
      createTransaction({ ...base, amount: 400 }),
      parent,
      createTransaction({
        ...base,
        amount: -500,
        categoryId: food.id,
        isChild: true,
        parentId: parent.id,
      }),
      createTransaction({ ...base, amount: -200, isChild: true, parentId: parent.id }),
      createTransaction({ ...base, amount: -999, isChild: true, parentId: "orphan" }),
      createTransaction({ ...base, amount: -999, transferId: "paired" }),
      createTransaction({ ...base, amount: 999, startingBalanceFlag: true }),
      createTransaction({ ...base, date: "2026-09-30", categoryId: food.id, amount: -2000 }),
      createTransaction({ ...base, date: "2026-09-01", categoryId: income.id, amount: 10000 }),
      createTransaction({ ...base, date: "2026-08-31", amount: 99999 }),
      createTransaction({ ...base, date: "2026-11-01", amount: -99999 }),
    ];
    await db.insert(s.transactions).values(rows);
    const report = await computeMonthlyReport(db, "2026-10");
    expect(report).toMatchObject({
      income: 3_500_000_300,
      expense: 1800,
      transactionCount: 7,
      hasAccounts: true,
      previous: { month: "2026-09", income: 10000, expense: 2000, transactionCount: 2 },
    });
    expect(report.categories).toEqual([
      { categoryId: food.id, name: "Food", icon: "basket", amount: 1300, previousAmount: 2000 },
      { categoryId: null, name: "Uncategorized", icon: null, amount: 500, previousAmount: 0 },
    ]);
    expect(report.categories.reduce((sum, row) => sum + row.amount, 0)).toBe(report.expense);
  });
  test("valid split children retain context across month boundaries; closed accounts remain in history", async () => {
    const db = dbFor(createMoneyTestEnv());
    const account = { ...createAccount({ name: "Old" }), closed: true };
    await db.insert(s.accounts).values(account);
    const parent = createTransaction({
      accountId: account.id,
      date: "2026-08-31",
      amount: -100,
      isParent: true,
    });
    const child = createTransaction({
      accountId: account.id,
      date: "2026-10-01",
      amount: -100,
      isChild: true,
      parentId: parent.id,
    });
    await db.insert(s.transactions).values([parent, child]);
    expect(await computeMonthlyReport(db, "2026-10")).toMatchObject({
      expense: 100,
      transactionCount: 1,
      hasAccounts: false,
    });
  });
  test("rejects malformed months and uses actual leap-year boundaries", () => {
    for (const month of ["2026-00", "2026-13", "26-01", "0000-01", "2026-01-01"])
      expect(validReportMonth(month)).toBe(false);
    const row = createTransaction({ accountId: "account", date: "2024-02-29", amount: -100 });
    expect(monthlyReport("2024-02", [row], [], true).expense).toBe(100);
    expect(monthlyReport("2024-03", [row], [], true).previous.expense).toBe(100);
    expect(() => monthlyReport("2026-13", [], [], false)).toThrow();
  });
});
