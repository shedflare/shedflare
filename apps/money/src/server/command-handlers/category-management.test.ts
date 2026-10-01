import { describe, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import * as s from "../../db/schema";
import type { CommandInvocation } from "../../domain/commands";
import { computeMonthBudget } from "../budget-engine";
async function fixture() {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  env.MONEY_DB.exec("PRAGMA foreign_keys = ON");
  async function create(invocation: CommandInvocation) {
    const result = await handleCommand(db, invocation);
    if (!result.ok || !result.data.id) throw Error("Fixture failed");
    return result.data.id;
  }
  const group = await create({
    commandType: "create_category_group",
    payload: { name: "Everyday" },
  });
  const otherGroup = await create({
    commandType: "create_category_group",
    payload: { name: "Bills" },
  });
  const incomeGroup = await create({
    commandType: "create_category_group",
    payload: { name: "Income", isIncome: true },
  });
  const a = await create({
    commandType: "create_category",
    payload: { name: "Food", groupId: group, icon: "basket" },
  });
  const b = await create({
    commandType: "create_category",
    payload: { name: "Coffee", groupId: group, icon: "coffee" },
  });
  const income = await create({
    commandType: "create_category",
    payload: { name: "Salary", groupId: incomeGroup },
  });
  const account = await create({ commandType: "create_account", payload: { name: "Everyday" } });
  const transaction = await create({
    commandType: "create_transaction",
    payload: { row: { accountId: account, categoryId: a, amount: -25000, date: "2026-10-01" } },
  });
  const schedule = await create({
    commandType: "create_schedule",
    payload: {
      schedule: {
        name: "Food",
        accountId: account,
        categoryId: a,
        amount: -25000,
        recurrenceRules: JSON.stringify({ type: "monthly" }),
        startDate: "2026-10-01",
        nextDate: "2026-10-01",
      },
    },
  });
  await handleCommand(db, {
    commandType: "set_budget_amount",
    payload: { categoryId: a, month: 202610, amount: 50000 },
  });
  return { env, db, group, otherGroup, incomeGroup, a, b, income, transaction, schedule };
}
describe("category management persistence", () => {
  test("renames and moves categories without changing icons, history, targets or budgets; income inherits its group", async () => {
    const f = await fixture();
    await handleCommand(f.db, {
      commandType: "update_category",
      payload: { id: f.a, goalDef: JSON.stringify({ type: "monthly", amount: 50000 }) },
    });
    expect(
      (
        await handleCommand(f.db, {
          commandType: "update_category",
          payload: { id: f.a, name: " Food & groceries ", groupId: f.otherGroup },
        })
      ).ok,
    ).toBe(true);
    const [row] = await f.db.select().from(s.categories).where(eq(s.categories.id, f.a)).all();
    expect(row).toMatchObject({
      name: "Food & groceries",
      icon: "basket",
      groupId: f.otherGroup,
      goalDef: JSON.stringify({ type: "monthly", amount: 50000 }),
    });
    expect(
      (await f.db.select().from(s.categories).where(eq(s.categories.id, f.income)).all())[0]
        .isIncome,
    ).toBe(true);
    expect((await f.db.select().from(s.transactions).all())[0].categoryId).toBe(f.a);
    expect((await f.db.select().from(s.budgets).all())[0].amount).toBe(50000);
    expect(
      (
        await handleCommand(f.db, {
          commandType: "update_category",
          payload: { id: f.a, groupId: f.incomeGroup },
        })
      ).ok,
    ).toBe(false);
  });
  test("reorder failures roll back every position and retry for categories and groups", async () => {
    const f = await fixture();
    const before = await f.db.select().from(s.categories).all();
    f.env.MONEY_DB.exec(
      `CREATE TRIGGER reject_order BEFORE UPDATE ON categories WHEN NEW.id = '${f.a}' BEGIN SELECT RAISE(ABORT, 'Unavailable'); END`,
    );
    await expect(
      handleCommand(f.db, { commandType: "reorder_categories", payload: { ids: [f.b, f.a] } }),
    ).rejects.toThrow();
    expect(await f.db.select().from(s.categories).all()).toEqual(before);
    f.env.MONEY_DB.exec("DROP TRIGGER reject_order");
    expect(
      (
        await handleCommand(f.db, {
          commandType: "reorder_categories",
          payload: { ids: [f.b, f.a] },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await f.db.select().from(s.categories).orderBy(s.categories.sortOrder).all())
        .slice(0, 2)
        .map((row) => row.id),
    ).toEqual([f.b, f.a]);
    const groups = await f.db.select().from(s.categoryGroups).all();
    f.env.MONEY_DB.exec(
      `CREATE TRIGGER reject_group_order BEFORE UPDATE ON category_groups WHEN NEW.id = '${f.group}' BEGIN SELECT RAISE(ABORT, 'Unavailable'); END`,
    );
    await expect(
      handleCommand(f.db, {
        commandType: "reorder_category_groups",
        payload: { ids: [f.otherGroup, f.group, f.incomeGroup] },
      }),
    ).rejects.toThrow();
    expect(await f.db.select().from(s.categoryGroups).all()).toEqual(groups);
    f.env.MONEY_DB.exec("DROP TRIGGER reject_group_order");
    expect(
      (
        await handleCommand(f.db, {
          commandType: "reorder_category_groups",
          payload: { ids: [f.otherGroup, f.group, f.incomeGroup] },
        })
      ).ok,
    ).toBe(true);
    for (const ids of [
      [f.a, f.a],
      [f.a, "missing"],
    ])
      expect(
        (await handleCommand(f.db, { commandType: "reorder_categories", payload: { ids } })).ok,
      ).toBe(false);
  });
  test("category deletion moves transactions and schedules atomically; source assignments are removed", async () => {
    const f = await fixture();
    f.env.MONEY_DB.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    const command = { commandType: "delete_category", payload: { id: f.a, transferToId: f.b } };
    await expect(handleCommand(f.db, command)).rejects.toThrow();
    expect((await f.db.select().from(s.transactions).all())[0].categoryId).toBe(f.a);
    expect((await f.db.select().from(s.schedules).all())[0].categoryId).toBe(f.a);
    expect(await f.db.select().from(s.budgets).all()).toHaveLength(1);
    f.env.MONEY_DB.exec("DROP TRIGGER reject_delete");
    expect((await handleCommand(f.db, command)).ok).toBe(true);
    expect((await f.db.select().from(s.transactions).all())[0]).toMatchObject({
      id: f.transaction,
      categoryId: f.b,
      amount: -25000,
    });
    expect((await f.db.select().from(s.schedules).all())[0]).toMatchObject({
      id: f.schedule,
      categoryId: f.b,
    });
    expect(await f.db.select().from(s.budgets).all()).toHaveLength(0);
  });
  test("group deletion retains category identity, transaction history and assignments after a failed batch and retry", async () => {
    const f = await fixture();
    f.env.MONEY_DB.exec(
      "CREATE TRIGGER reject_group_delete BEFORE DELETE ON category_groups BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    const command = {
      commandType: "delete_category_group",
      payload: { id: f.group, transferToGroupId: f.otherGroup },
    };
    await expect(handleCommand(f.db, command)).rejects.toThrow();
    expect(
      (await f.db.select().from(s.categories).where(eq(s.categories.id, f.a)).all())[0].groupId,
    ).toBe(f.group);
    f.env.MONEY_DB.exec("DROP TRIGGER reject_group_delete");
    expect((await handleCommand(f.db, command)).ok).toBe(true);
    expect(
      (await f.db.select().from(s.categories).where(eq(s.categories.id, f.a)).all())[0].groupId,
    ).toBe(f.otherGroup);
    expect((await f.db.select().from(s.transactions).all())[0].categoryId).toBe(f.a);
    expect(await f.db.select().from(s.budgets).all()).toHaveLength(1);
  });
  test("hiding categories preserves income and assigned money while removing their rows", async () => {
    const f = await fixture();
    const [account] = await f.db.select().from(s.accounts).all();
    await handleCommand(f.db, {
      commandType: "create_transaction",
      payload: {
        row: { accountId: account.id, categoryId: f.income, amount: 100_000, date: "2026-10-01" },
      },
    });
    const before = await computeMonthBudget(f.db, 202610);
    await handleCommand(f.db, {
      commandType: "update_category",
      payload: { id: f.a, hidden: true },
    });
    await handleCommand(f.db, {
      commandType: "update_category",
      payload: { id: f.income, hidden: true },
    });
    const hidden = await computeMonthBudget(f.db, 202610);
    expect(hidden?.toBudget).toBe(before?.toBudget);
    expect(hidden?.categories.some((row) => row.categoryId === f.a)).toBe(false);
    expect(await f.db.select().from(s.budgets).all()).toHaveLength(1);
    await handleCommand(f.db, {
      commandType: "update_category",
      payload: { id: f.a, hidden: false },
    });
    await handleCommand(f.db, {
      commandType: "update_category",
      payload: { id: f.income, hidden: false },
    });
    expect(await computeMonthBudget(f.db, 202610)).toEqual(before);
  });
  test("invalid deletion destinations never change stored records", async () => {
    const f = await fixture();
    for (const transferToId of [f.a, "missing", f.income])
      expect(
        (
          await handleCommand(f.db, {
            commandType: "delete_category",
            payload: { id: f.a, transferToId },
          })
        ).ok,
      ).toBe(false);
    for (const transferToGroupId of [f.group, "missing", f.incomeGroup])
      expect(
        (
          await handleCommand(f.db, {
            commandType: "delete_category_group",
            payload: { id: f.group, transferToGroupId },
          })
        ).ok,
      ).toBe(false);
    expect(await f.db.select().from(s.categories).all()).toHaveLength(3);
    expect((await f.db.select().from(s.transactions).all())[0].categoryId).toBe(f.a);
  });
});
