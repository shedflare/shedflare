import { expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { createMoneyTestEnv, dbFor } from "../../test/helpers";
import { createAccount } from "../../domain/factories";
import { parseCsv } from "../../domain/csv-import";
import { CommandResponseSchema, TransactionsResponseSchema } from "../../domain/schemas-client";
import * as s from "../../db/schema";
import { createRouter } from "../router";

test("Indonesian CSV rows cross the REST boundary with exact amounts and real import counts", async () => {
  const env = createMoneyTestEnv();
  const account = createAccount({ name: "BCA" });
  await dbFor(env).insert(s.accounts).values(account).run();
  const router = createRouter({
    ...env,
    // SAFETY: Local SQLite implements the D1 operations used by the REST router.
    MONEY_DB: env.MONEY_DB as typeof env.MONEY_DB & D1Database,
    // SAFETY: Import commands do not use upload storage.
    UPLOADS: env.UPLOADS as typeof env.UPLOADS & R2Bucket,
  });
  const parsed = parseCsv(
    "Tanggal;Nominal;Keterangan\n01/10/2026;-Rp1.250.000;Rent\n01/10/2026;Rp12.500.000;Salary",
  );
  expect(parsed.errors).toEqual([]);
  const response = await router.fetch(
    new Request("http://localhost/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandType: "import_transactions",
        payload: { accountId: account.id, transactions: parsed.rows, isPreview: false },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const result = Schema.decodeUnknownSync(CommandResponseSchema)(await response.json());
  expect(result).toEqual({ ok: true, data: { added: 2, updated: 0, errors: [] } });
  const records = await router.fetch(new Request("http://localhost/api/transactions"));
  const ledger = Schema.decodeUnknownSync(TransactionsResponseSchema)(await records.json());
  expect(ledger.transactions.map((row) => row.amount).sort((a, b) => a - b)).toEqual([
    -125_000_000, 1_250_000_000,
  ]);
});
