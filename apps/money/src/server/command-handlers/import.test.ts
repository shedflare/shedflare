import { expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import { createAccount, createCategory, createTransaction } from "../../domain/factories";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "./handle-command";
async function fixture() {
  const env = createMoneyTestEnv();
  env.MONEY_DB.exec("PRAGMA foreign_keys = ON");
  const db = dbFor(env);
  const account = createAccount({ name: "BCA" }),
    other = createAccount({ name: "Other" }),
    category = createCategory({ name: "Food", groupId: null });
  await db.insert(s.accounts).values([account, other]);
  await db.insert(s.categories).values(category);
  const rows = [
    {
      date: "2026-10-01",
      amount: -2500000,
      payee: "Market",
      notes: 'One\n"Two"',
      category: "Food",
      importedDescription: "Same description",
    },
    {
      date: "2026-10-02",
      amount: -500000,
      payee: "Coffee",
      importedDescription: "Same description",
    },
  ];
  const payload = {
    accountId: account.id,
    transactions: rows,
    requestId: "test-import",
    skipDuplicates: true,
  };
  return { env, db, account, other, category, payload };
}
test("imports atomically, retries after failure and lost responses, and restores exact rows through undo and redo", async () => {
  const f = await fixture();
  f.env.MONEY_DB.exec(
    "CREATE TRIGGER fail_second_import BEFORE INSERT ON transactions WHEN NEW.payee = 'Coffee' BEGIN SELECT RAISE(ABORT,'write failed'); END",
  );
  await expect(
    handleCommand(f.db, { commandType: "import_transactions", payload: f.payload }),
  ).rejects.toThrow("write failed");
  expect(await f.db.select().from(s.transactions).all()).toHaveLength(0);
  expect(await f.db.select().from(s.transactionImports).all()).toHaveLength(0);
  f.env.MONEY_DB.exec("DROP TRIGGER fail_second_import");
  const saved = await handleCommand(f.db, {
    commandType: "import_transactions",
    payload: f.payload,
  });
  expect(saved).toMatchObject({ ok: true, data: { id: "test-import", added: 2, skipped: 0 } });
  const original = await f.db.select().from(s.transactions).all();
  expect(original[0]).toMatchObject({ categoryId: f.category.id, notes: 'One\n"Two"' });
  expect(
    await handleCommand(f.db, { commandType: "import_transactions", payload: f.payload }),
  ).toEqual(saved);
  expect(await f.db.select().from(s.transactions).all()).toEqual(original);
  expect(
    (
      await handleCommand(f.db, {
        commandType: "import_transactions",
        payload: { ...f.payload, transactions: [{ ...f.payload.transactions[0], amount: 1 }] },
      })
    ).ok,
  ).toBe(false);
  f.env.MONEY_DB.exec(
    "CREATE TRIGGER fail_undo_import BEFORE DELETE ON transactions WHEN OLD.payee = 'Coffee' BEGIN SELECT RAISE(ABORT,'undo failed'); END",
  );
  await expect(
    handleCommand(f.db, { commandType: "undo_transaction_import", payload: { id: "test-import" } }),
  ).rejects.toThrow("undo failed");
  expect(await f.db.select().from(s.transactions).all()).toEqual(original);
  expect((await f.db.select().from(s.transactionImports).all())[0].state).toBe("active");
  f.env.MONEY_DB.exec("DROP TRIGGER fail_undo_import");
  expect(
    (
      await handleCommand(f.db, {
        commandType: "undo_transaction_import",
        payload: { id: "test-import" },
      })
    ).ok,
  ).toBe(true);
  expect(await f.db.select().from(s.transactions).all()).toHaveLength(0);
  expect(
    (
      await handleCommand(f.db, {
        commandType: "undo_transaction_import",
        payload: { id: "test-import" },
      })
    ).ok,
  ).toBe(true);
  expect(
    await handleCommand(f.db, { commandType: "import_transactions", payload: f.payload }),
  ).toEqual(saved);
  expect(await f.db.select().from(s.transactions).all()).toEqual(original);
  await f.db
    .update(s.transactions)
    .set({ notes: "Edited" })
    .where(eq(s.transactions.id, original[0].id));
  expect(
    (
      await handleCommand(f.db, {
        commandType: "undo_transaction_import",
        payload: { id: "test-import" },
      })
    ).ok,
  ).toBe(false);
  expect(await f.db.select().from(s.transactions).all()).toHaveLength(2);
  // Undoing an edit restores the values but legitimately advances updatedAt.
  await f.db
    .update(s.transactions)
    .set({ notes: original[0].notes, updatedAt: "2030-01-01T12:00:00.000Z" })
    .where(eq(s.transactions.id, original[0].id));
  expect(
    (
      await handleCommand(f.db, {
        commandType: "undo_transaction_import",
        payload: { id: "test-import" },
      })
    ).ok,
  ).toBe(true);
  expect(await f.db.select().from(s.transactions).all()).toHaveLength(0);
});
test("duplicates are scoped to the account and consumed by count, never overwritten by description", async () => {
  const f = await fixture();
  const otherRow = createTransaction({ ...f.payload.transactions[0], accountId: f.other.id });
  await f.db.insert(s.transactions).values(otherRow);
  const saved = await handleCommand(f.db, {
    commandType: "import_transactions",
    payload: f.payload,
  });
  expect(saved).toMatchObject({ ok: true, data: { added: 2, skipped: 0 } });
  const retry = await handleCommand(f.db, {
    commandType: "import_transactions",
    payload: { ...f.payload, requestId: "again" },
  });
  expect(retry).toMatchObject({ ok: true, data: { added: 0, skipped: 2 } });
  const repeated = await handleCommand(f.db, {
    commandType: "import_transactions",
    payload: {
      ...f.payload,
      requestId: "twice",
      transactions: [f.payload.transactions[0], f.payload.transactions[0]],
    },
  });
  expect(repeated).toMatchObject({ ok: true, data: { added: 1, skipped: 1 } });
  const include = await handleCommand(f.db, {
    commandType: "import_transactions",
    payload: { ...f.payload, requestId: "include", skipDuplicates: false },
  });
  expect(include).toMatchObject({ ok: true, data: { added: 2, skipped: 0 } });
  expect(
    (await f.db.select().from(s.transactions).where(eq(s.transactions.id, otherRow.id)).all())[0],
  ).toEqual(otherRow);
});
test("preview never persists; invalid dates, fractional IDR, closed accounts and oversized imports fail before writing", async () => {
  const f = await fixture();
  expect(
    await handleCommand(f.db, {
      commandType: "import_transactions",
      payload: { ...f.payload, isPreview: true },
    }),
  ).toMatchObject({ ok: true, data: { added: 2 } });
  expect(await f.db.select().from(s.transactions).all()).toHaveLength(0);
  expect(await f.db.select().from(s.transactionImports).all()).toHaveLength(0);
  const invalid = [
    { ...f.payload, transactions: [{ date: "2026-02-30", amount: 100 }] },
    { ...f.payload, transactions: [{ date: "2026-10-01", amount: 1.5 }] },
    { ...f.payload, accountId: "missing" },
    { ...f.payload, transactions: Array.from({ length: 501 }, () => f.payload.transactions[0]) },
  ];
  for (const payload of invalid)
    expect((await handleCommand(f.db, { commandType: "import_transactions", payload })).ok).toBe(
      false,
    );
  await f.db.insert(s.settings).values({
    id: "currency",
    key: "display_currency",
    value: "IDR",
    updatedAt: new Date().toISOString(),
  });
  expect(
    (
      await handleCommand(f.db, {
        commandType: "import_transactions",
        payload: { ...f.payload, transactions: [{ date: "2026-10-01", amount: 101 }] },
      })
    ).ok,
  ).toBe(false);
  await f.db.update(s.accounts).set({ closed: true }).where(eq(s.accounts.id, f.account.id));
  expect(
    (await handleCommand(f.db, { commandType: "import_transactions", payload: f.payload })).ok,
  ).toBe(false);
  expect(await f.db.select().from(s.transactions).all()).toHaveLength(0);
});

test("a maximum-size import and its undo/redo stay within D1 parameter and invocation limits", async () => {
  const f = await fixture();
  const prepare = f.env.MONEY_DB.prepare.bind(f.env.MONEY_DB);
  let queryCount = 0;
  f.env.MONEY_DB.prepare = (sql) => {
    queryCount++;
    if (queryCount > 50) throw Error("D1 Free query limit");
    const statement = prepare(sql);
    const bind = statement.bind;
    statement.bind = (...params) => {
      if (params.length > 100) throw Error("D1 bound parameter limit");
      return bind(...params);
    };
    return statement;
  };
  const transactions = Array.from({ length: 200 }, (_, index) => ({
    date: "2026-10-01",
    amount: -(index + 1) * 100,
    payee: "Purchase " + index,
  }));
  const payload = { ...f.payload, transactions };
  expect(await handleCommand(f.db, { commandType: "import_transactions", payload })).toMatchObject({
    ok: true,
    data: { added: 200 },
  });
  queryCount = 0;
  expect(
    (
      await handleCommand(f.db, {
        commandType: "undo_transaction_import",
        payload: { id: "test-import" },
      })
    ).ok,
  ).toBe(true);
  queryCount = 0;
  expect(await handleCommand(f.db, { commandType: "import_transactions", payload })).toMatchObject({
    ok: true,
    data: { added: 200 },
  });
});
