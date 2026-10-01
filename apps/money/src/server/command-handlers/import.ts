import { and, eq, inArray } from "drizzle-orm";
import * as Schema from "effect/Schema";
import type { Db } from "../d1-access";
import * as s from "../../db/schema";
import { createTransaction } from "../../domain/factories";
import { nowIso, parseCalendarDate } from "../../domain/types";
import { TransactionSchema } from "../../domain/schemas";
import { duplicateRows, CSV_IMPORT_MAX_ROWS } from "../../domain/csv-import";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";

type ImportInvocation = Extract<
  CommandInvocation,
  { commandType: "import_transactions" | "undo_transaction_import" }
>;
const readRows = Schema.decodeUnknownSync(Schema.Array(TransactionSchema));
function chunks<T>(rows: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) =>
    rows.slice(index * size, (index + 1) * size),
  );
}
function snapshot(rows: readonly s.Transaction[]): string {
  return JSON.stringify(
    rows
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((row) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(([key]) => key !== "updatedAt")
            .toSorted(([a], [b]) => a.localeCompare(b)),
        ),
      ),
  );
}
export async function handleImportCommands(
  command: ImportInvocation,
  db: Db,
): Promise<CommandResult> {
  if (command.commandType === "undo_transaction_import") {
    const id = command.payload.id;
    const [receipt] = await db
      .select()
      .from(s.transactionImports)
      .where(eq(s.transactionImports.id, id))
      .all();
    if (!receipt) return { ok: false, error: "Import not found" };
    if (receipt.state === "undone") return { ok: true, data: { id } };
    const rows = readRows(JSON.parse(receipt.rows));
    const ids = rows.map((row) => row.id);
    const idGroups = chunks(ids, 99);
    const current = (
      await Promise.all(
        idGroups.map((group) =>
          db.select().from(s.transactions).where(inArray(s.transactions.id, group)).all(),
        ),
      )
    ).flat();
    const tags = (
      await Promise.all(
        idGroups.map((group) =>
          db
            .select()
            .from(s.transactionTags)
            .where(inArray(s.transactionTags.transactionId, group))
            .limit(1)
            .all(),
        ),
      )
    ).flat();
    if (tags.length || snapshot(current) !== snapshot(rows))
      return { ok: false, error: "Imported transactions have changed. Remove them individually." };
    await db.batch([
      db
        .delete(s.transactionImports)
        .where(and(eq(s.transactionImports.id, id), eq(s.transactionImports.state, "active"))),
      db.insert(s.transactionImports).values({ ...receipt, state: "undone" }),
      ...idGroups.map((group) =>
        db.delete(s.transactions).where(inArray(s.transactions.id, group)),
      ),
    ]);
    return { ok: true, data: { id } };
  }
  const p = command.payload;
  if (!p.transactions.length) return { ok: true, data: { added: 0, updated: 0, errors: [] } };
  if (p.transactions.length > CSV_IMPORT_MAX_ROWS)
    return { ok: false, error: `Import up to ${CSV_IMPORT_MAX_ROWS} transactions at a time` };
  if (p.requestId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(p.requestId))
    return { ok: false, error: "Invalid import request" };
  const id = p.requestId ?? crypto.randomUUID();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        accountId: p.accountId,
        transactions: p.transactions,
        skipDuplicates: p.skipDuplicates ?? true,
      }),
    ),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const [receipt] = await db
    .select()
    .from(s.transactionImports)
    .where(eq(s.transactionImports.id, id))
    .all();
  if (receipt && receipt.fingerprint !== fingerprint)
    return { ok: false, error: "This import request has changed. Choose the file again." };
  const response = (rows: readonly s.Transaction[], skipped: number): CommandResult => ({
    ok: true,
    data: { id, added: rows.length, updated: 0, skipped, errors: [] },
  });
  if (receipt?.state === "active")
    return response(readRows(JSON.parse(receipt.rows)), receipt.skipped);
  const [account] = await db.select().from(s.accounts).where(eq(s.accounts.id, p.accountId)).all();
  if (!account || account.closed) return { ok: false, error: "Choose an open account" };
  const [currency] = await db
    .select()
    .from(s.settings)
    .where(eq(s.settings.key, "display_currency"))
    .all();
  for (const row of p.transactions) {
    if (
      !parseCalendarDate(row.date) ||
      !Number.isSafeInteger(row.amount) ||
      (currency?.value === "IDR" && row.amount % 100 !== 0)
    )
      return { ok: false, error: "Check the dates and amounts before importing" };
  }
  const categories = await db.select().from(s.categories).all();
  if (receipt?.state === "undone") {
    const rows = readRows(JSON.parse(receipt.rows));
    if (
      rows.some(
        (row) => row.categoryId && !categories.some((category) => category.id === row.categoryId),
      )
    )
      return { ok: false, error: "An imported category was removed. Choose the file again." };
    if (p.isPreview) return response(rows, receipt.skipped);
    await db.batch([
      db
        .delete(s.transactionImports)
        .where(and(eq(s.transactionImports.id, id), eq(s.transactionImports.state, "undone"))),
      db.insert(s.transactionImports).values({ ...receipt, state: "active" }),
      ...chunks(rows, 5).map((group) => db.insert(s.transactions).values(group)),
    ]);
    return response(rows, receipt.skipped);
  }
  const existing = await db
    .select()
    .from(s.transactions)
    .where(and(eq(s.transactions.accountId, p.accountId), eq(s.transactions.isChild, false)))
    .all();
  const duplicates =
    p.skipDuplicates === false ? new Set<number>() : duplicateRows(p.transactions, existing);
  const rows = p.transactions.flatMap((tx, index) => {
    if (duplicates.has(index)) return [];
    const matches = tx.category
      ? categories.filter(
          (category) => category.name.toLocaleLowerCase() === tx.category?.toLocaleLowerCase(),
        )
      : [];
    return [
      createTransaction({
        ...tx,
        accountId: p.accountId,
        categoryId: matches.length === 1 ? matches[0].id : null,
      }),
    ];
  });
  if (p.isPreview) return response(rows, duplicates.size);
  try {
    await db.batch([
      db.insert(s.transactionImports).values({
        id,
        accountId: p.accountId,
        fingerprint,
        rows: JSON.stringify(rows),
        skipped: duplicates.size,
        state: "active",
        createdAt: nowIso(),
      }),
      // Five rows bind 95 parameters. With 200 rows the entire request fits D1 Free limits.
      // https://developers.cloudflare.com/d1/platform/limits/
      ...chunks(rows, 5).map((group) => db.insert(s.transactions).values(group)),
    ]);
  } catch (caught) {
    const [saved] = await db
      .select()
      .from(s.transactionImports)
      .where(eq(s.transactionImports.id, id))
      .all();
    if (saved?.state === "active" && saved.fingerprint === fingerprint)
      return response(readRows(JSON.parse(saved.rows)), saved.skipped);
    throw caught;
  }
  return response(rows, duplicates.size);
}
