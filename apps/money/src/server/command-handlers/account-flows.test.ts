import { describe, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import { computeNetWorth } from "../budget-engine";
import type { CommandResult } from "../../domain/types";
function id(result: CommandResult) {
  if (!result.ok || !result.data.id) throw new Error("Fixture failed");
  return result.data.id;
}
async function setup() {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  const fromAccountId = id(
    await handleCommand(db, {
      commandType: "create_account",
      payload: { name: "Everyday", balance: 1_000_000_000 },
    }),
  );
  const toAccountId = id(
    await handleCommand(db, {
      commandType: "create_account",
      payload: { name: "Savings", balance: 500_000_000 },
    }),
  );
  return { env, db, fromAccountId, toAccountId };
}
describe("paired account transfers", () => {
  test("writes opposite linked entries, preserves net worth, and prevents independent financial edits", async () => {
    const { db, fromAccountId, toAccountId } = await setup();
    const before = await computeNetWorth(db);
    const result = await handleCommand(db, {
      commandType: "create_account_transfer",
      payload: {
        fromAccountId,
        toAccountId,
        amount: 125_000_000,
        date: "2026-10-01",
        notes: "Savings",
      },
    });
    const transferId = id(result);
    const rows = await db.select().from(s.transactions).all();
    expect(rows).toHaveLength(2);
    const debit = rows.find((row) => row.id === transferId)!;
    const credit = rows.find((row) => row.id === debit.transferId)!;
    expect(debit).toMatchObject({
      accountId: fromAccountId,
      amount: -125_000_000,
      payee: "Savings",
      categoryId: null,
      notes: "Savings",
    });
    expect(credit).toMatchObject({
      accountId: toAccountId,
      amount: 125_000_000,
      payee: "Everyday",
      transferId: debit.id,
    });
    expect(await computeNetWorth(db)).toBe(before);
    for (const fields of [
      { amount: -5 },
      { date: "2026-10-02" },
      { accountId: toAccountId },
      { categoryId: null },
    ]) {
      expect(
        (
          await handleCommand(db, {
            commandType: "update_transaction",
            payload: { id: debit.id, fields },
          })
        ).ok,
      ).toBe(false);
    }
    expect(
      (await handleCommand(db, { commandType: "delete_transaction", payload: { id: credit.id } }))
        .ok,
    ).toBe(false);
    expect(
      (
        await handleCommand(db, {
          commandType: "update_transaction",
          payload: { id: debit.id, fields: { notes: "Edited", cleared: true } },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await handleCommand(db, {
          commandType: "delete_account_transfer",
          payload: { id: credit.id },
        })
      ).ok,
    ).toBe(true);
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
    expect(await computeNetWorth(db)).toBe(before);
  });
  test("rolls back a failed second insert or delete and retries without a half transfer", async () => {
    const { env, db, fromAccountId, toAccountId } = await setup();
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_credit BEFORE INSERT ON transactions WHEN NEW.amount > 0 BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    const command = {
      commandType: "create_account_transfer",
      payload: { fromAccountId, toAccountId, amount: 125_000_000, date: "2026-10-01" },
    };
    await expect(handleCommand(db, command)).rejects.toThrow();
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
    env.MONEY_DB.exec("DROP TRIGGER reject_credit");
    const transferId = id(await handleCommand(db, command));
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_credit_delete BEFORE DELETE ON transactions WHEN OLD.amount > 0 BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    await expect(
      handleCommand(db, { commandType: "delete_account_transfer", payload: { id: transferId } }),
    ).rejects.toThrow();
    expect(await db.select().from(s.transactions).all()).toHaveLength(2);
    env.MONEY_DB.exec("DROP TRIGGER reject_credit_delete");
    expect(
      (
        await handleCommand(db, {
          commandType: "delete_account_transfer",
          payload: { id: transferId },
        })
      ).ok,
    ).toBe(true);
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
  });
  test("rejects invalid input, closed accounts, unsafe balances, and deleting reconciled transfers", async () => {
    const { db, fromAccountId, toAccountId } = await setup();
    const payload = { fromAccountId, toAccountId, amount: 100, date: "2026-10-01" };
    for (const patch of [
      { amount: 0 },
      { amount: -1 },
      { amount: 0.5 },
      { amount: Number.MAX_SAFE_INTEGER },
      { fromAccountId: toAccountId },
      { toAccountId: "missing" },
      { date: "2026-02-30" },
    ])
      expect(
        (
          await handleCommand(db, {
            commandType: "create_account_transfer",
            payload: { ...payload, ...patch },
          })
        ).ok,
      ).toBe(false);
    await handleCommand(db, { commandType: "close_account", payload: { id: toAccountId } });
    expect((await handleCommand(db, { commandType: "create_account_transfer", payload })).ok).toBe(
      false,
    );
    await handleCommand(db, { commandType: "reopen_account", payload: { id: toAccountId } });
    const transferId = id(
      await handleCommand(db, { commandType: "create_account_transfer", payload }),
    );
    await handleCommand(db, {
      commandType: "update_transaction",
      payload: { id: transferId, fields: { reconciled: true } },
    });
    expect(
      (
        await handleCommand(db, {
          commandType: "delete_account_transfer",
          payload: { id: transferId },
        })
      ).ok,
    ).toBe(false);
    expect(await db.select().from(s.transactions).all()).toHaveLength(2);
  });
});
describe("account reconciliation", () => {
  test("compares cleared balance, adds the correctly signed adjustment, and leaves pending transactions alone", async () => {
    const { db, fromAccountId } = await setup();
    const cleared = id(
      await handleCommand(db, {
        commandType: "create_transaction",
        payload: {
          row: {
            accountId: fromAccountId,
            amount: -100_000_000,
            date: "2026-10-01",
            cleared: true,
          },
        },
      }),
    );
    const pending = id(
      await handleCommand(db, {
        commandType: "create_transaction",
        payload: {
          row: {
            accountId: fromAccountId,
            amount: -50_000_000,
            date: "2026-10-01",
            cleared: false,
          },
        },
      }),
    );
    expect(
      (
        await handleCommand(db, {
          commandType: "reconcile_account",
          payload: {
            accountId: fromAccountId,
            expectedBalance: 900_000_000,
            statementBalance: 925_000_000,
          },
        })
      ).ok,
    ).toBe(true);
    const rows = await db.select().from(s.transactions).all();
    expect(rows.find((row) => row.id === cleared)?.reconciled).toBe(true);
    expect(rows.find((row) => row.id === pending)?.reconciled).toBe(false);
    expect(rows.find((row) => row.payee === "Balance adjustment")).toMatchObject({
      amount: 25_000_000,
      cleared: true,
      reconciled: true,
    });
    expect(
      (await db.select().from(s.accounts).where(eq(s.accounts.id, fromAccountId)).all())[0]
        .lastReconciled,
    ).not.toBeNull();
  });
  test("rolls back all reconciliation writes on failure, rejects stale balance, and retries", async () => {
    const { db, env, fromAccountId } = await setup();
    const txId = id(
      await handleCommand(db, {
        commandType: "create_transaction",
        payload: {
          row: { accountId: fromAccountId, amount: -100, date: "2026-10-01", cleared: true },
        },
      }),
    );
    const payload = {
      accountId: fromAccountId,
      expectedBalance: 999_999_900,
      statementBalance: 1_000_000_000,
    };
    expect(
      (
        await handleCommand(db, {
          commandType: "reconcile_account",
          payload: { ...payload, expectedBalance: 0 },
        })
      ).ok,
    ).toBe(false);
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_adjustment BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    await expect(
      handleCommand(db, { commandType: "reconcile_account", payload }),
    ).rejects.toThrow();
    expect(
      (await db.select().from(s.transactions).where(eq(s.transactions.id, txId)).all())[0]
        .reconciled,
    ).toBe(false);
    expect(
      (await db.select().from(s.accounts).where(eq(s.accounts.id, fromAccountId)).all())[0]
        .lastReconciled,
    ).toBeNull();
    env.MONEY_DB.exec("DROP TRIGGER reject_adjustment");
    expect((await handleCommand(db, { commandType: "reconcile_account", payload })).ok).toBe(true);
    expect(await db.select().from(s.transactions).all()).toHaveLength(2);
  });
});
