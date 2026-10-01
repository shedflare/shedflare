import { describe, expect, test } from "vite-plus/test";
import * as s from "../../db/schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import { computeMonthBudget } from "../budget-engine";
import type { CommandResult } from "../../domain/types";

function id(result: CommandResult): string {
  if (!result.ok || !result.data.id) throw new Error("Fixture creation failed");
  return result.data.id;
}

async function setup() {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  const account = id(
    await handleCommand(db, { commandType: "create_account", payload: { name: "Everyday" } }),
  );
  const from = id(
    await handleCommand(db, {
      commandType: "create_category",
      payload: { name: "Groceries", groupId: null },
    }),
  );
  const to = id(
    await handleCommand(db, {
      commandType: "create_category",
      payload: { name: "Coffee", groupId: null },
    }),
  );
  await handleCommand(db, {
    commandType: "set_budget_amount",
    payload: { month: 202609, categoryId: from, amount: 10_000 },
  });
  await handleCommand(db, {
    commandType: "set_budget_amount",
    payload: { month: 202609, categoryId: to, amount: 2_000 },
  });
  await handleCommand(db, {
    commandType: "create_transaction",
    payload: { row: { accountId: account, categoryId: to, amount: -3_000, date: "2026-09-10" } },
  });
  return { env, db, from, to };
}

describe("budget moves", () => {
  test("fills last month atomically and preserves existing assignments", async () => {
    const { env, db, from, to } = await setup();
    env.MONEY_DB.exec(
      `CREATE TRIGGER reject_copy BEFORE INSERT ON budgets WHEN NEW.month = 202610 AND NEW.category_id = '${to}' BEGIN SELECT RAISE(ABORT, 'Destination unavailable'); END`,
    );
    await expect(
      handleCommand(db, { commandType: "copy_previous_month", payload: { month: "2026-10" } }),
    ).rejects.toThrow();
    const failed = await computeMonthBudget(db, 202610);
    expect(failed?.categories.find((category) => category.categoryId === from)?.budgeted).toBe(0);
    expect(failed?.categories.find((category) => category.categoryId === to)?.budgeted).toBe(0);
    env.MONEY_DB.exec("DROP TRIGGER reject_copy");
    await handleCommand(db, {
      commandType: "set_budget_amount",
      payload: { month: 202610, categoryId: from, amount: 9_000 },
    });
    expect(
      (
        await handleCommand(db, {
          commandType: "copy_previous_month",
          payload: { month: "2026-10" },
        })
      ).ok,
    ).toBe(true);
    const filled = await computeMonthBudget(db, 202610);
    expect(filled?.categories.find((category) => category.categoryId === from)?.budgeted).toBe(
      9_000,
    );
    expect(filled?.categories.find((category) => category.categoryId === to)?.budgeted).toBe(2_000);
  });
  test("covers overspending, conserves assigned money, and reverses through the undo command", async () => {
    const { db, from, to } = await setup();
    const moved = await handleCommand(db, {
      commandType: "transfer_budget",
      payload: { month: "2026-09", from, to, amount: 1_000 },
    });
    expect(moved.ok).toBe(true);
    const after = await computeMonthBudget(db, 202609);
    expect(after?.categories.find((category) => category.categoryId === to)?.leftover).toBe(0);
    expect(after?.categories.find((category) => category.categoryId === from)?.budgeted).toBe(
      9_000,
    );
    expect(after?.categories.reduce((sum, category) => sum + category.budgeted, 0)).toBe(12_000);
    const undone = await handleCommand(db, {
      commandType: "transfer_budget",
      payload: { month: "2026-09", from: to, to: from, amount: 1_000 },
    });
    expect(undone.ok).toBe(true);
    const restored = await computeMonthBudget(db, 202609);
    expect(restored?.categories.find((category) => category.categoryId === from)?.budgeted).toBe(
      10_000,
    );
    expect(restored?.categories.find((category) => category.categoryId === to)?.leftover).toBe(
      -1_000,
    );
  });

  test("rolls back both sides when the destination write fails and can retry", async () => {
    const { env, db, from, to } = await setup();
    // SQLite aborts the second statement inside the same batch D1 uses for the move.
    env.MONEY_DB.exec(
      `CREATE TRIGGER reject_move BEFORE UPDATE ON budgets WHEN NEW.category_id = '${to}' BEGIN SELECT RAISE(ABORT, 'Destination unavailable'); END`,
    );
    await expect(
      handleCommand(db, {
        commandType: "transfer_budget",
        payload: { month: "2026-09", from, to, amount: 1_000 },
      }),
    ).rejects.toThrow();
    const rows = await db.select().from(s.budgets).all();
    expect(rows.find((row) => row.categoryId === from)?.amount).toBe(10_000);
    expect(rows.find((row) => row.categoryId === to)?.amount).toBe(2_000);
    env.MONEY_DB.exec("DROP TRIGGER reject_move");
    expect(
      (
        await handleCommand(db, {
          commandType: "transfer_budget",
          payload: { month: "2026-09", from, to, amount: 1_000 },
        })
      ).ok,
    ).toBe(true);
  });

  test.each([0, -100, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid amount %s without changing assignments",
    async (amount) => {
      const { db, from, to } = await setup();
      expect(
        (
          await handleCommand(db, {
            commandType: "transfer_budget",
            payload: { month: "2026-09", from, to, amount },
          })
        ).ok,
      ).toBe(false);
      expect(
        (await db.select().from(s.budgets).all()).find((row) => row.categoryId === from)?.amount,
      ).toBe(10_000);
    },
  );

  test("rejects same-category, income-category, and invalid-month moves", async () => {
    const { db, from, to } = await setup();
    const income = id(
      await handleCommand(db, {
        commandType: "create_category",
        payload: { name: "Salary", groupId: null, isIncome: true },
      }),
    );
    for (const payload of [
      { month: "2026-09", from, to: from, amount: 100 },
      { month: "2026-09", from, to: income, amount: 100 },
      { month: "2026-13", from, to, amount: 100 },
    ]) {
      expect((await handleCommand(db, { commandType: "transfer_budget", payload })).ok).toBe(false);
    }
  });
});
