import { describe, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import type { CommandResult } from "../../domain/types";
import { computeMonthBudget } from "../budget-engine";

function id(result: CommandResult) {
  if (!result.ok || !result.data.id) throw new Error("Fixture creation failed");
  return result.data.id;
}
async function setup() {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  const from = id(
    await handleCommand(db, {
      commandType: "create_category",
      payload: { name: "Groceries", groupId: null },
    }),
  );
  const to = id(
    await handleCommand(db, {
      commandType: "create_category",
      payload: { name: "Holiday", groupId: null },
    }),
  );
  await handleCommand(db, {
    commandType: "set_budget_amount",
    payload: { month: 202610, categoryId: from, amount: 450_000_000 },
  });
  await handleCommand(db, {
    commandType: "set_budget_carryover",
    payload: { month: 202610, categoryId: from, carryover: true },
  });
  return { env, db, from, to };
}

describe("monthly planning persistence", () => {
  test("assigns a whole plan, preserves carryover, and undoes deltas without erasing later edits", async () => {
    const { db, from, to } = await setup();
    const allocations = [
      { categoryId: from, amount: 50_000_000 },
      { categoryId: to, amount: 400_000_000 },
    ];
    expect(
      (
        await handleCommand(db, {
          commandType: "allocate_budget",
          payload: { month: "2026-10", allocations },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await computeMonthBudget(db, 202610))?.categories.find((row) => row.categoryId === from),
    ).toMatchObject({ budgeted: 500_000_000, carryover: true });
    await handleCommand(db, {
      commandType: "set_budget_amount",
      payload: { month: 202610, categoryId: from, amount: 525_000_000 },
    });
    expect(
      (
        await handleCommand(db, {
          commandType: "allocate_budget",
          payload: {
            month: "2026-10",
            allocations: allocations.map((row) => ({ ...row, amount: -row.amount })),
          },
        })
      ).ok,
    ).toBe(true);
    const after = await computeMonthBudget(db, 202610);
    expect(after?.categories.find((row) => row.categoryId === from)).toMatchObject({
      budgeted: 475_000_000,
      carryover: true,
    });
    expect(after?.categories.find((row) => row.categoryId === to)?.budgeted).toBe(0);
    expect(after?.toBudget).toBe(-475_000_000);
  });
  test("rolls back every category after a failed second write and persists on retry", async () => {
    const { env, db, from, to } = await setup();
    env.MONEY_DB.exec(
      `CREATE TRIGGER reject_plan BEFORE INSERT ON budgets WHEN NEW.category_id = '${to}' BEGIN SELECT RAISE(ABORT, 'Unavailable'); END`,
    );
    const command = {
      commandType: "allocate_budget",
      payload: {
        month: "2026-10",
        allocations: [
          { categoryId: from, amount: 100 },
          { categoryId: to, amount: 200 },
        ],
      },
    };
    await expect(handleCommand(db, command)).rejects.toThrow();
    expect((await db.select().from(s.budgets).all()).map((row) => row.amount)).toEqual([
      450_000_000,
    ]);
    env.MONEY_DB.exec("DROP TRIGGER reject_plan");
    expect((await handleCommand(db, command)).ok).toBe(true);
    const after = await computeMonthBudget(db, 202610);
    expect(after?.categories.find((row) => row.categoryId === from)?.budgeted).toBe(450_000_100);
    expect(after?.categories.find((row) => row.categoryId === to)?.budgeted).toBe(200);
  });
  test("rejects invalid months, duplicate, hidden, income and missing categories, unsafe amounts, and overflow without writes", async () => {
    const { db, from, to } = await setup();
    await db.update(s.categories).set({ hidden: true }).where(eq(s.categories.id, to)).run();
    const income = id(
      await handleCommand(db, {
        commandType: "create_category",
        payload: { name: "Income", groupId: null, isIncome: true },
      }),
    );
    const payloads = [
      { month: "2026-13", allocations: [{ categoryId: from, amount: 100 }] },
      { month: "2026-10", allocations: [] },
      {
        month: "2026-10",
        allocations: [
          { categoryId: from, amount: 100 },
          { categoryId: from, amount: 100 },
        ],
      },
      ...[to, income, "missing"].map((categoryId) => ({
        month: "2026-10",
        allocations: [
          { categoryId: from, amount: 100 },
          { categoryId, amount: 100 },
        ],
      })),
      ...[0, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1].map((amount) => ({
        month: "2026-10",
        allocations: [{ categoryId: from, amount }],
      })),
    ];
    for (const payload of payloads)
      expect((await handleCommand(db, { commandType: "allocate_budget", payload })).ok).toBe(false);
    expect((await db.select().from(s.budgets).all()).map((row) => row.amount)).toEqual([
      450_000_000,
    ]);
  });
  test("monthly planning works across a year boundary and leaves other months unchanged", async () => {
    const { db, from } = await setup();
    expect(
      (
        await handleCommand(db, {
          commandType: "allocate_budget",
          payload: { month: "2027-01", allocations: [{ categoryId: from, amount: 123_456_700 }] },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await computeMonthBudget(db, 202701))?.categories.find((row) => row.categoryId === from)
        ?.budgeted,
    ).toBe(123_456_700);
    expect(
      (await computeMonthBudget(db, 202610))?.categories.find((row) => row.categoryId === from)
        ?.budgeted,
    ).toBe(450_000_000);
  });
});

describe("copying a full monthly budget", () => {
  test("copies full values, reduces existing assignments to match, includes zero, preserves carryover, and reverses as one plan", async () => {
    const { db, from, to } = await setup();
    const old = [
      { categoryId: from, amount: 600_000_000 },
      { categoryId: to, amount: 10_000_000 },
    ];
    expect(
      (
        await handleCommand(db, {
          commandType: "set_budget_plan",
          payload: { month: "2026-11", assignments: old },
        })
      ).ok,
    ).toBe(true);
    await handleCommand(db, {
      commandType: "set_budget_carryover",
      payload: { month: 202611, categoryId: from, carryover: true },
    });
    const prior = await computeMonthBudget(db, 202610);
    const assignments = prior!.categories.map((row) => ({
      categoryId: row.categoryId,
      amount: row.budgeted,
    }));
    expect(
      (
        await handleCommand(db, {
          commandType: "set_budget_plan",
          payload: { month: "2026-11", assignments },
        })
      ).ok,
    ).toBe(true);
    const copied = await computeMonthBudget(db, 202611);
    expect(copied?.categories.find((row) => row.categoryId === from)).toMatchObject({
      budgeted: 450_000_000,
      carryover: true,
    });
    expect(copied?.categories.find((row) => row.categoryId === to)?.budgeted).toBe(0);
    expect((await computeMonthBudget(db, 202610))?.categories).toEqual(prior?.categories);
    expect(
      (
        await handleCommand(db, {
          commandType: "set_budget_plan",
          payload: { month: "2026-11", assignments: old },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await computeMonthBudget(db, 202611))?.categories.find((row) => row.categoryId === from)
        ?.budgeted,
    ).toBe(600_000_000);
    expect(
      (await computeMonthBudget(db, 202611))?.categories.find((row) => row.categoryId === to)
        ?.budgeted,
    ).toBe(10_000_000);
  });
  test("a failed copy rolls back all replacements and can retry", async () => {
    const { env, db, from, to } = await setup();
    env.MONEY_DB.exec(
      `CREATE TRIGGER reject_copy_plan BEFORE INSERT ON budgets WHEN NEW.category_id = '${to}' BEGIN SELECT RAISE(ABORT, 'Unavailable'); END`,
    );
    const command = {
      commandType: "set_budget_plan",
      payload: {
        month: "2026-10",
        assignments: [
          { categoryId: from, amount: 300_000_000 },
          { categoryId: to, amount: 100_000_000 },
        ],
      },
    };
    await expect(handleCommand(db, command)).rejects.toThrow();
    expect((await db.select().from(s.budgets).all()).map((row) => row.amount)).toEqual([
      450_000_000,
    ]);
    env.MONEY_DB.exec("DROP TRIGGER reject_copy_plan");
    expect((await handleCommand(db, command)).ok).toBe(true);
    expect(
      (await computeMonthBudget(db, 202610))?.categories.find((row) => row.categoryId === from)
        ?.budgeted,
    ).toBe(300_000_000);
    expect(
      (await computeMonthBudget(db, 202610))?.categories.find((row) => row.categoryId === to)
        ?.budgeted,
    ).toBe(100_000_000);
  });
  test("validates the whole copy before writing", async () => {
    const { db, from, to } = await setup();
    await db.update(s.categories).set({ hidden: true }).where(eq(s.categories.id, to)).run();
    const income = id(
      await handleCommand(db, {
        commandType: "create_category",
        payload: { name: "Income", groupId: null, isIncome: true },
      }),
    );
    const payloads = [
      { month: "2026-13", assignments: [{ categoryId: from, amount: 100 }] },
      { month: "2026-10", assignments: [] },
      {
        month: "2026-10",
        assignments: [
          { categoryId: from, amount: 100 },
          { categoryId: from, amount: 200 },
        ],
      },
      ...[to, income, "missing"].map((categoryId) => ({
        month: "2026-10",
        assignments: [
          { categoryId: from, amount: 100 },
          { categoryId, amount: 100 },
        ],
      })),
      ...[0.5, Number.MAX_SAFE_INTEGER + 1].map((amount) => ({
        month: "2026-10",
        assignments: [{ categoryId: from, amount }],
      })),
    ];
    for (const payload of payloads)
      expect((await handleCommand(db, { commandType: "set_budget_plan", payload })).ok).toBe(false);
    expect((await db.select().from(s.budgets).all()).map((row) => row.amount)).toEqual([
      450_000_000,
    ]);
  });
  test("last-month spending includes valid split allocations and refunds once, while bank balances count the parent once", async () => {
    const { db, from, to } = await setup();
    const account = id(
      await handleCommand(db, {
        commandType: "create_account",
        payload: { name: "Everyday", balance: 20_000 },
      }),
    );
    for (const [categoryId, amount] of [
      [from, 5_000],
      [to, 1_000],
    ] as const)
      await handleCommand(db, {
        commandType: "set_budget_amount",
        payload: { month: 202610, categoryId, amount },
      });
    const parent = id(
      await handleCommand(db, {
        commandType: "create_transaction",
        payload: { row: { accountId: account, date: "2026-10-31", amount: -7_000 } },
      }),
    );
    await handleCommand(db, {
      commandType: "split_transaction",
      payload: {
        parentId: parent,
        children: [
          { accountId: account, date: "2026-10-31", categoryId: from, amount: -6_000 },
          { accountId: account, date: "2026-10-31", categoryId: to, amount: -1_000 },
        ],
      },
    });
    await handleCommand(db, {
      commandType: "create_transaction",
      payload: { row: { accountId: account, date: "2026-10-31", categoryId: from, amount: 500 } },
    });
    const month = await computeMonthBudget(db, 202610);
    expect(month?.categories.find((row) => row.categoryId === from)?.spent).toBe(-5_500);
    expect(month?.categories.find((row) => row.categoryId === to)?.spent).toBe(-1_000);
    const { computeNetWorth } = await import("../budget-engine");
    expect(await computeNetWorth(db)).toBe(13_500);
    const next = await computeMonthBudget(db, 202611);
    expect(next?.categories.find((row) => row.categoryId === from)?.leftover).toBe(0);
    expect(next?.categories.find((row) => row.categoryId === to)?.leftover).toBe(0);
  });
});
