import { describe, expect, test } from "vite-plus/test";
import * as s from "../../db/schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import type { CommandResult } from "../../domain/types";

function id(result: CommandResult) {
  if (!result.ok || !result.data.id) throw new Error("Fixture creation failed");
  return result.data.id;
}
async function setup() {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  const accountId = id(
    await handleCommand(db, { commandType: "create_account", payload: { name: "Everyday" } }),
  );
  const transactionId = id(
    await handleCommand(db, {
      commandType: "create_transaction",
      payload: { row: { accountId, date: "2026-10-01", amount: -12_500_000, cleared: false } },
    }),
  );
  return { env, db, transactionId };
}

describe("activity edits", () => {
  test("persists multiple edits and restores nullable fields exactly through undo", async () => {
    const { db, transactionId } = await setup();
    expect(
      (
        await handleCommand(db, {
          commandType: "update_transaction",
          payload: {
            id: transactionId,
            fields: {
              amount: -125_000_000,
              payee: "Market",
              notes: "Eggs",
              cleared: true,
              date: "2026-10-02",
            },
          },
        })
      ).ok,
    ).toBe(true);
    expect((await db.select().from(s.transactions).all())[0]).toMatchObject({
      amount: -125_000_000,
      payee: "Market",
      notes: "Eggs",
      cleared: true,
      date: "2026-10-02",
    });
    expect(
      (
        await handleCommand(db, {
          commandType: "update_transaction",
          payload: {
            id: transactionId,
            fields: {
              amount: -12_500_000,
              payee: null,
              notes: null,
              cleared: false,
              date: "2026-10-01",
            },
          },
        })
      ).ok,
    ).toBe(true);
    expect((await db.select().from(s.transactions).all())[0]).toMatchObject({
      amount: -12_500_000,
      payee: null,
      notes: null,
      cleared: false,
      date: "2026-10-01",
    });
  });
  test("a failed save leaves the record unchanged and can retry", async () => {
    const { env, db, transactionId } = await setup();
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_edit BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    const command = {
      commandType: "update_transaction",
      payload: { id: transactionId, fields: { amount: -125_000_000, notes: "Keep this draft" } },
    };
    await expect(handleCommand(db, command)).rejects.toThrow();
    expect((await db.select().from(s.transactions).all())[0]).toMatchObject({
      amount: -12_500_000,
      notes: null,
    });
    env.MONEY_DB.exec("DROP TRIGGER reject_edit");
    expect((await handleCommand(db, command)).ok).toBe(true);
    expect((await db.select().from(s.transactions).all())[0]).toMatchObject({
      amount: -125_000_000,
      notes: "Keep this draft",
    });
  });
  test("rejects unsafe amounts, invalid calendar dates, and missing transactions", async () => {
    const { db, transactionId } = await setup();
    for (const fields of [
      { amount: 0.5 },
      { amount: Number.MAX_SAFE_INTEGER + 1 },
      { date: "2026-02-30" },
      { date: "invalid" },
    ])
      expect(
        (
          await handleCommand(db, {
            commandType: "update_transaction",
            payload: { id: transactionId, fields },
          })
        ).ok,
      ).toBe(false);
    expect(
      (
        await handleCommand(db, {
          commandType: "update_transaction",
          payload: { id: "missing", fields: { notes: "No ghost saves" } },
        })
      ).ok,
    ).toBe(false);
    expect((await db.select().from(s.transactions).all())[0]).toMatchObject({
      amount: -12_500_000,
      date: "2026-10-01",
    });
  });
});
