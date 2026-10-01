import { describe, expect, test } from "vite-plus/test";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
import * as s from "../../db/schema";
import { readSetupState, STARTER_CATEGORIES } from "../../domain/setup";
const payload = {
  mode: "complete",
  requestId: "first-run",
  currency: "IDR",
  account: { name: "Everyday", balance: 500_000_000 },
  categories: STARTER_CATEGORIES,
};
describe("first-run setup", () => {
  test("saves all owner data together, retries once, and rejects altered requests or another setup", async () => {
    const db = dbFor(createMoneyTestEnv());
    const first = await handleCommand(db, { commandType: "setup_money", payload });
    expect(first.ok).toBe(true);
    expect(await handleCommand(db, { commandType: "setup_money", payload })).toEqual(first);
    const accounts = await db.select().from(s.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: "Everyday", balanceCurrent: 500_000_000 });
    const categories = await db.select().from(s.categories).all();
    expect(categories).toHaveLength(6);
    expect(categories.find((row) => row.name === "Groceries")?.icon).toBe("basket");
    expect(await db.select().from(s.categoryGroups).all()).toHaveLength(1);
    const settings = await db.select().from(s.settings).all();
    expect(settings.find((row) => row.key === "display_currency")?.value).toBe("IDR");
    expect(readSetupState(settings.find((row) => row.key === "money_setup")?.value)?.state).toBe(
      "complete",
    );
    for (const change of [{ requestId: "second" }, { account: { name: "Changed", balance: 0 } }])
      expect(
        (
          await handleCommand(db, {
            commandType: "setup_money",
            payload: { ...payload, ...change },
          })
        ).ok,
      ).toBe(false);
  });
  test("rolls back every write on failure, including the guard, and retains a retryable request", async () => {
    const env = createMoneyTestEnv();
    const db = dbFor(env);
    env.MONEY_DB.exec(
      "CREATE TRIGGER reject_setup BEFORE INSERT ON categories BEGIN SELECT RAISE(ABORT, 'Unavailable'); END",
    );
    await expect(handleCommand(db, { commandType: "setup_money", payload })).rejects.toThrow();
    expect(await db.select().from(s.accounts).all()).toHaveLength(0);
    expect(await db.select().from(s.categoryGroups).all()).toHaveLength(0);
    expect(await db.select().from(s.settings).all()).toHaveLength(0);
    env.MONEY_DB.exec("DROP TRIGGER reject_setup");
    expect((await handleCommand(db, { commandType: "setup_money", payload })).ok).toBe(true);
  });
  test("concurrent setup requests create one account and one set of categories", async () => {
    const db = dbFor(createMoneyTestEnv());
    const results = await Promise.all(
      [payload, { ...payload, requestId: "other" }].map((payload) =>
        handleCommand(db, { commandType: "setup_money", payload }),
      ),
    );
    expect(results.filter((row) => row.ok)).toHaveLength(1);
    expect(await db.select().from(s.accounts).all()).toHaveLength(1);
    expect(await db.select().from(s.categories).all()).toHaveLength(6);
  });
  test("skip persists currency without records and can be followed by setup without categories", async () => {
    const db = dbFor(createMoneyTestEnv());
    const skip = {
      commandType: "setup_money",
      payload: { mode: "skip", currency: "IDR", requestId: "skip" },
    };
    expect((await handleCommand(db, skip)).ok).toBe(true);
    expect((await handleCommand(db, skip)).ok).toBe(true);
    expect(await db.select().from(s.accounts).all()).toHaveLength(0);
    expect(
      (
        await handleCommand(db, {
          commandType: "setup_money",
          payload: { ...payload, categories: [] },
        })
      ).ok,
    ).toBe(true);
    expect(await db.select().from(s.categories).all()).toHaveLength(0);
    expect(await db.select().from(s.accounts).all()).toHaveLength(1);
  });
  test("invalid whole-rupiah balances, duplicate names, and pre-existing records cannot change currency", async () => {
    const db = dbFor(createMoneyTestEnv());
    for (const change of [
      { account: { name: "", balance: 0 } },
      { account: { name: "Everyday", balance: 101 } },
      { account: { name: "Everyday", balance: Number.MAX_SAFE_INTEGER + 1 } },
      { categories: [STARTER_CATEGORIES[0], { ...STARTER_CATEGORIES[0], name: " groceries " }] },
    ])
      expect(
        (
          await handleCommand(db, {
            commandType: "setup_money",
            payload: { ...payload, ...change },
          })
        ).ok,
      ).toBe(false);
    expect(await db.select().from(s.settings).all()).toHaveLength(0);
    await handleCommand(db, { commandType: "create_account", payload: { name: "Existing" } });
    expect(
      (
        await handleCommand(db, {
          commandType: "setup_money",
          payload: { mode: "skip", currency: "IDR", requestId: "skip" },
        })
      ).ok,
    ).toBe(false);
    expect(await db.select().from(s.settings).all()).toHaveLength(0);
  });
});
