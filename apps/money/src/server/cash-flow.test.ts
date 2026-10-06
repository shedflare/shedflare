import { expect, test } from "vite-plus/test";
import { createMoneyTestEnv, dbFor } from "../test/helpers";
import * as s from "../db/schema";
import { createAccount, createCategory, createTransaction } from "../domain/factories";
import { formatCalendarDate, prevMonthKey } from "../domain/types";
import { computeCashFlow } from "./budget-engine";
import { computeMonthlyReport } from "./monthly-report";

test("cash flow includes uncategorized purchases and agrees with the monthly report", async () => {
  const db = dbFor(createMoneyTestEnv());
  const month = prevMonthKey(formatCalendarDate(new Date()).slice(0, 7));
  const account = createAccount({ name: "Everyday" });
  const income = createCategory({ name: "Salary", groupId: null, isIncome: true });
  const home = createCategory({ name: "Home & Living", groupId: null });
  const ai = createCategory({ name: "AI", groupId: null });
  await db.insert(s.accounts).values(account);
  await db.insert(s.categories).values([income, home, ai]);
  const base = { accountId: account.id, date: `${month}-15` };
  await db
    .insert(s.transactions)
    .values([
      createTransaction({ ...base, categoryId: income.id, amount: 960_000_000 }),
      createTransaction({ ...base, categoryId: home.id, amount: -270_000_000 }),
      createTransaction({ ...base, categoryId: ai.id, amount: -39_000_000 }),
      createTransaction({ ...base, amount: -600_000_000 }),
    ]);
  const flow = (await computeCashFlow(db, 1)).find((row) => row.month === month)!;
  const report = await computeMonthlyReport(db, month);
  expect(flow).toEqual({ month, income: 960_000_000, expense: 909_000_000 });
  expect(flow.income - flow.expense).toBe(51_000_000);
  expect(flow).toMatchObject({ income: report.income, expense: report.expense });
});

test("cash flow shares report rules for refunds, splits, hidden categories, and excluded entries", async () => {
  const db = dbFor(createMoneyTestEnv());
  const month = formatCalendarDate(new Date()).slice(0, 7);
  const previous = prevMonthKey(month);
  const account = { ...createAccount({ name: "Closed" }), closed: true };
  const food = { ...createCategory({ name: "Food", groupId: null }), hidden: true };
  const income = createCategory({ name: "Income", groupId: null, isIncome: true });
  await db.insert(s.accounts).values(account);
  await db.insert(s.categories).values([food, income]);
  const base = { accountId: account.id, date: `${month}-01` };
  const parent = createTransaction({
    ...base,
    date: `${previous}-01`,
    amount: -700,
    isParent: true,
  });
  await db.insert(s.transactions).values([
    parent,
    createTransaction({
      ...base,
      categoryId: food.id,
      amount: -500,
      isChild: true,
      parentId: parent.id,
    }),
    createTransaction({ ...base, amount: -200, isChild: true, parentId: parent.id }),
    createTransaction({ ...base, categoryId: food.id, amount: 900 }),
    createTransaction({ ...base, amount: 400 }),
    createTransaction({ ...base, categoryId: income.id, amount: -100 }),
    createTransaction({ ...base, amount: -999, isChild: true, parentId: "orphan" }),
    createTransaction({ ...base, amount: -999, transferId: "paired" }),
    createTransaction({ ...base, amount: 999, startingBalanceFlag: true }),
  ]);
  const flow = await computeCashFlow(db, 0);
  const report = await computeMonthlyReport(db, month);
  expect(flow).toEqual([{ month, income: 300, expense: -200 }]);
  expect(flow[0]).toMatchObject({ income: report.income, expense: report.expense });
});
