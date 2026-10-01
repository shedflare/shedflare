import { describe, expect, test } from "vite-plus/test";
import * as s from "../../db/schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import type { CommandResult } from "../../domain/types";
function id(result: CommandResult) {
  if (!result.ok || !result.data.id) throw new Error("Fixture failed");
  return result.data.id;
}
async function setup() {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  const accountId = id(
    await handleCommand(db, { commandType: "create_account", payload: { name: "Everyday" } }),
  );
  const categoryId = id(
    await handleCommand(db, {
      commandType: "create_category",
      payload: { name: "Internet", groupId: null },
    }),
  );
  const scheduleId = id(
    await handleCommand(db, {
      commandType: "create_schedule",
      payload: {
        schedule: {
          accountId,
          categoryId,
          name: "Internet",
          amount: -45_000_000,
          startDate: "2026-01-31",
          nextDate: "2026-01-31",
          recurrenceRules: JSON.stringify({ type: "monthly" }),
        },
      },
    }),
  );
  return { env, db, accountId, categoryId, scheduleId };
}
describe("recurring payments", () => {
  test("records in the chosen account/category, advances month-end date, and restores exact state when undone", async () => {
    const { db, accountId, categoryId, scheduleId } = await setup();
    const [before] = await db.select().from(s.schedules).all();
    const result = await handleCommand(db, {
      commandType: "post_schedule_transaction",
      payload: { scheduleId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data.transactionId) throw new Error("No payment");
    expect((await db.select().from(s.transactions).all())[0]).toMatchObject({
      accountId,
      categoryId,
      amount: -45_000_000,
      date: "2026-01-31",
      payee: "Internet",
      scheduleId,
    });
    expect((await db.select().from(s.schedules).all())[0].nextDate).toBe("2026-02-28");
    expect(
      (
        await handleCommand(db, {
          commandType: "undo_schedule_payment",
          payload: {
            scheduleId,
            transactionId: result.data.transactionId,
            nextDate: before.nextDate,
            completed: before.completed,
            recurrenceRules: before.recurrenceRules,
          },
        })
      ).ok,
    ).toBe(true);
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
    expect((await db.select().from(s.schedules).all())[0]).toMatchObject({
      nextDate: before.nextDate,
      completed: before.completed,
      recurrenceRules: before.recurrenceRules,
    });
  });
  test("failed date advancement and failed undo roll back both records and retry", async () => {
    const { env, db, scheduleId } = await setup();
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_advance BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    await expect(
      handleCommand(db, { commandType: "post_schedule_transaction", payload: { scheduleId } }),
    ).rejects.toThrow();
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
    expect((await db.select().from(s.schedules).all())[0].nextDate).toBe("2026-01-31");
    env.MONEY_DB.exec("DROP TRIGGER reject_advance");
    const result = await handleCommand(db, {
      commandType: "post_schedule_transaction",
      payload: { scheduleId },
    });
    if (!result.ok || !result.data.transactionId) throw new Error("No payment");
    const undo = {
      commandType: "undo_schedule_payment",
      payload: {
        scheduleId,
        transactionId: result.data.transactionId,
        nextDate: "2026-01-31",
        completed: false,
        recurrenceRules: JSON.stringify({ type: "monthly" }),
      },
    };
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_restore BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    await expect(handleCommand(db, undo)).rejects.toThrow();
    expect(await db.select().from(s.transactions).all()).toHaveLength(1);
    expect((await db.select().from(s.schedules).all())[0].nextDate).toBe("2026-02-28");
    env.MONEY_DB.exec("DROP TRIGGER reject_restore");
    expect((await handleCommand(db, undo)).ok).toBe(true);
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
  });
  test("persists next date, account, category, amount, and lifecycle flags; paused or finished payments cannot post", async () => {
    const { db, scheduleId } = await setup();
    expect(
      (
        await handleCommand(db, {
          commandType: "update_schedule",
          payload: {
            id: scheduleId,
            fields: {
              amount: 0,
              nextDate: "2026-10-15",
              startDate: "2026-10-01",
              active: false,
              completed: false,
              categoryId: null,
            },
          },
        })
      ).ok,
    ).toBe(true);
    expect((await db.select().from(s.schedules).all())[0]).toMatchObject({
      amount: 0,
      nextDate: "2026-10-15",
      startDate: "2026-10-01",
      active: false,
      categoryId: null,
    });
    for (const command of [
      { commandType: "post_schedule_transaction", payload: { scheduleId } },
      { commandType: "skip_schedule_date", payload: { id: scheduleId } },
    ])
      expect((await handleCommand(db, command)).ok).toBe(false);
    await handleCommand(db, {
      commandType: "update_schedule",
      payload: { id: scheduleId, fields: { active: true, completed: true } },
    });
    expect(
      (
        await handleCommand(db, {
          commandType: "post_schedule_transaction",
          payload: { scheduleId },
        })
      ).ok,
    ).toBe(false);
    for (const fields of [
      { nextDate: "2026-02-30" },
      { amount: 0.5 },
      { amount: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        (
          await handleCommand(db, {
            commandType: "update_schedule",
            payload: { id: scheduleId, fields },
          })
        ).ok,
      ).toBe(false);
  });
  test("skipping advances without a transaction and preserves end conditions on restore", async () => {
    const { db, scheduleId } = await setup();
    const rules = JSON.stringify({ type: "weekly", endMode: "after_n", endOccurrences: 1 });
    await handleCommand(db, {
      commandType: "update_schedule",
      payload: { id: scheduleId, fields: { recurrenceRules: rules } },
    });
    await handleCommand(db, { commandType: "skip_schedule_date", payload: { id: scheduleId } });
    expect((await db.select().from(s.schedules).all())[0]).toMatchObject({
      nextDate: null,
      completed: true,
    });
    expect(await db.select().from(s.transactions).all()).toHaveLength(0);
    await handleCommand(db, {
      commandType: "update_schedule",
      payload: {
        id: scheduleId,
        fields: { nextDate: "2026-01-31", completed: false, recurrenceRules: rules },
      },
    });
    expect((await db.select().from(s.schedules).all())[0].recurrenceRules).toBe(rules);
  });
});
