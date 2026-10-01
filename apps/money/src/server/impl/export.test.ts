import { expect, test } from "vite-plus/test";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { handleCommand } from "../command-handlers/handle-command";
import { createRouter } from "../router";
import type { CommandInvocation } from "../../domain/commands";

test("the CSV download preserves rupiah amounts, distinct names, quotes and multiline notes", async () => {
  const env = createMoneyTestEnv();
  const db = dbFor(env);
  async function create(invocation: CommandInvocation) {
    const result = await handleCommand(db, invocation);
    if (!result.ok || !result.data.id) throw Error("Fixture failed");
    return result.data.id;
  }
  const accountId = await create({
    commandType: "create_account",
    payload: { name: 'Daily "wallet"' },
  });
  const categoryId = await create({
    commandType: "create_category",
    payload: { name: "Food, drinks", groupId: null },
  });
  await create({
    commandType: "create_transaction",
    payload: {
      row: {
        accountId,
        categoryId,
        date: "2026-10-01",
        amount: -125_000_000,
        payee: 'Toko "Budi", Jakarta',
        notes: 'First line\nSecond "line"',
      },
    },
  });
  const router = createRouter({
    ...env,
    // SAFETY: The SQLite shim implements the prepare, batch and raw methods used by the REST router.
    MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
    // SAFETY: The export endpoint does not access R2; the mock provides the upload binding surface.
    UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
  });
  const response = await router.fetch(new Request("http://localhost/api/export/csv"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("charset=utf-8");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(await response.text()).toBe(
    'Date,Amount,Payee,Category,Notes,Account\n2026-10-01,-1250000,"Toko ""Budi"", Jakarta","Food, drinks","First line\nSecond ""line""","Daily ""wallet"""',
  );
});

test("account CSV exports count split parents once and can be imported with exact ordinary amounts and categories", async () => {
  const env = createMoneyTestEnv(),
    db = dbFor(env);
  async function create(invocation: CommandInvocation) {
    const result = await handleCommand(db, invocation);
    if (!result.ok || !result.data.id) throw Error("Fixture failed");
    return result.data.id;
  }
  const source = await create({ commandType: "create_account", payload: { name: "Source" } });
  const other = await create({ commandType: "create_account", payload: { name: "Other" } });
  const target = await create({ commandType: "create_account", payload: { name: "Imported" } });
  const category = await create({
    commandType: "create_category",
    payload: { name: "Food", groupId: null },
  });
  const parent = await create({
    commandType: "create_transaction",
    payload: {
      row: {
        accountId: source,
        categoryId: null,
        date: "2026-10-01",
        amount: -10000,
        payee: "Split shop",
      },
    },
  });
  await handleCommand(db, {
    commandType: "split_transaction",
    payload: {
      parentId: parent,
      children: [
        { accountId: source, categoryId: category, date: "2026-10-01", amount: -4000 },
        { accountId: source, categoryId: category, date: "2026-10-01", amount: -6000 },
      ],
    },
  });
  await create({
    commandType: "create_transaction",
    payload: {
      row: {
        accountId: source,
        categoryId: category,
        date: "2026-10-02",
        amount: -125000000,
        payee: 'Toko "Budi"',
        notes: "Line one\nLine two",
      },
    },
  });
  await create({
    commandType: "create_transaction",
    payload: {
      row: { accountId: other, date: "2026-10-01", amount: 99900, payee: "Other account" },
    },
  });
  const router = createRouter({
    ...env,
    // SAFETY: Local SQLite and R2 mocks implement the bindings used by this REST router.
    MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
    // SAFETY: CSV export and import do not access upload storage.
    UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
  });
  const response = await router.fetch(
    new Request("http://localhost/api/export/csv?accountId=" + source),
  );
  const csv = await response.text();
  const { parseCsv } = await import("../../domain/csv-import");
  const parsed = parseCsv(csv, undefined, { currency: "IDR" });
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows).toHaveLength(2);
  expect(parsed.rows.reduce((sum, row) => sum + row.amount, 0)).toBe(-125010000);
  expect(
    await handleCommand(db, {
      commandType: "import_transactions",
      payload: { accountId: target, requestId: "round-trip", transactions: parsed.rows },
    }),
  ).toMatchObject({ ok: true, data: { added: 2 } });
  const records = await db
    .select()
    .from((await import("../../db/schema")).transactions)
    .all();
  expect(
    records.filter((row) => row.accountId === target).find((row) => row.payee === 'Toko "Budi"'),
  ).toMatchObject({ categoryId: category, amount: -125000000, notes: "Line one\nLine two" });
});
