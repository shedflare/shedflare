import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../d1-access";
import * as s from "../../db/schema";
import { createTransaction } from "../../domain/factories";
import { nowIso, parseCalendarDate } from "../../domain/types";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";

type TransactionCommand =
  | "create_transaction"
  | "create_account_transfer"
  | "delete_account_transfer"
  | "update_transaction"
  | "delete_transaction"
  | "split_transaction";

type TransactionInvocation = Extract<CommandInvocation, { commandType: TransactionCommand }>;

export async function handleTransactionCommands(
  command: TransactionInvocation,
  db: Db,
): Promise<CommandResult> {
  switch (command.commandType) {
    case "create_account_transfer": {
      const p = command.payload;
      if (
        p.fromAccountId === p.toAccountId ||
        !Number.isSafeInteger(p.amount) ||
        p.amount <= 0 ||
        !parseCalendarDate(p.date)
      )
        return {
          ok: false,
          error: "Choose two different accounts, a valid date, and a positive amount",
        };
      const accounts = await db
        .select()
        .from(s.accounts)
        .where(inArray(s.accounts.id, [p.fromAccountId, p.toAccountId]))
        .all();
      const from = accounts.find((row) => row.id === p.fromAccountId);
      const to = accounts.find((row) => row.id === p.toAccountId);
      if (!from || !to || from.closed || to.closed)
        return { ok: false, error: "Choose two open accounts" };
      for (const [account, delta] of [
        [from, -p.amount],
        [to, p.amount],
      ] as const) {
        const balance = await db.get<{ balance: number }>(
          sql`SELECT COALESCE(${account.balanceCurrent}, 0) + COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE account_id = ${account.id} AND is_child = 0`,
        );
        if (
          !Number.isSafeInteger(Number(balance?.balance ?? 0)) ||
          !Number.isSafeInteger(Number(balance?.balance ?? 0) + delta)
        )
          return { ok: false, error: "The transfer amount is too large" };
      }
      const debit = createTransaction({
        accountId: from.id,
        amount: -p.amount,
        date: p.date,
        payee: p.fromPayee !== undefined ? p.fromPayee : to.name,
        notes: p.fromNotes !== undefined ? p.fromNotes : p.notes,
        cleared: p.fromCleared,
      });
      const credit = createTransaction({
        accountId: to.id,
        amount: p.amount,
        date: p.date,
        payee: p.toPayee !== undefined ? p.toPayee : from.name,
        notes: p.toNotes !== undefined ? p.toNotes : p.notes,
        cleared: p.toCleared,
        transferId: debit.id,
      });
      debit.transferId = credit.id;
      await db.batch([
        db.insert(s.transactions).values(debit),
        db.insert(s.transactions).values(credit),
      ]);
      return { ok: true, data: { id: debit.id, transactionId: credit.id } };
    }
    case "delete_account_transfer": {
      const [row] = await db
        .select()
        .from(s.transactions)
        .where(eq(s.transactions.id, command.payload.id))
        .all();
      const [other] = row?.transferId
        ? await db.select().from(s.transactions).where(eq(s.transactions.id, row.transferId)).all()
        : [];
      if (
        !row ||
        !other ||
        other.transferId !== row.id ||
        other.accountId === row.accountId ||
        other.amount !== -row.amount
      )
        return { ok: false, error: "The linked transfer no longer exists" };
      if (row.reconciled || other.reconciled)
        return { ok: false, error: "A reconciled transfer cannot be removed" };
      await db.batch([
        db.delete(s.transactions).where(eq(s.transactions.id, row.id)),
        db.delete(s.transactions).where(eq(s.transactions.id, other.id)),
      ]);
      return { ok: true, data: { id: row.id } };
    }
    case "create_transaction": {
      const p = command.payload;
      const row = createTransaction(p.row);
      await db.insert(s.transactions).values(row).run();
      return { ok: true, data: { id: row.id } };
    }

    case "update_transaction": {
      const p = command.payload;
      if (p.fields.amount !== undefined && !Number.isSafeInteger(p.fields.amount)) {
        return { ok: false, error: "Enter a valid whole amount" };
      }
      if (p.fields.date !== undefined && !parseCalendarDate(p.fields.date)) {
        return { ok: false, error: "Choose a valid date" };
      }
      const [existing] = await db
        .select()
        .from(s.transactions)
        .where(eq(s.transactions.id, p.id))
        .all();
      if (!existing) return { ok: false, error: "Transaction no longer exists" };
      if (
        existing.transferId &&
        (p.fields.accountId !== undefined ||
          p.fields.categoryId !== undefined ||
          p.fields.amount !== undefined ||
          p.fields.date !== undefined)
      )
        return { ok: false, error: "Transfer amounts, accounts, and dates must stay linked" };
      const set: Partial<typeof s.transactions.$inferInsert> = { updatedAt: nowIso() };
      const f = p.fields;
      if (f.accountId !== undefined) set.accountId = f.accountId;
      if (f.categoryId !== undefined) set.categoryId = f.categoryId;
      if (f.amount !== undefined) set.amount = f.amount;
      if (f.payee !== undefined) set.payee = f.payee;
      if (f.notes !== undefined) set.notes = f.notes;
      if (f.date !== undefined) set.date = f.date;
      if (f.cleared !== undefined) set.cleared = f.cleared;
      if (f.reconciled !== undefined) set.reconciled = f.reconciled;
      if (f.importedDescription !== undefined) set.importedDescription = f.importedDescription;
      if (f.sortOrder !== undefined) set.sortOrder = f.sortOrder;

      await db.update(s.transactions).set(set).where(eq(s.transactions.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "delete_transaction": {
      const p = command.payload;
      const [existing] = await db
        .select()
        .from(s.transactions)
        .where(eq(s.transactions.id, p.id))
        .all();
      if (existing?.transferId) return { ok: false, error: "Remove the paired transfer together" };
      // Cascade: remove split children first (no FK cascade in schema).
      await db.delete(s.transactions).where(eq(s.transactions.parentId, p.id)).run();
      await db.delete(s.transactions).where(eq(s.transactions.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "split_transaction": {
      const p = command.payload;
      const [parent] = await db
        .select()
        .from(s.transactions)
        .where(eq(s.transactions.id, p.parentId))
        .all();
      if (!parent) return { ok: false, error: "Parent transaction not found" };
      if (parent.transferId) return { ok: false, error: "A transfer cannot be split" };
      if (parent.isChild) return { ok: false, error: "Cannot split a child transaction" };
      if (p.children.length === 0) return { ok: false, error: "Split requires at least one child" };

      const childSum = p.children.reduce((sum: number, c: { amount: number }) => sum + c.amount, 0);
      if (childSum !== parent.amount) {
        return {
          ok: false,
          error: `Split amounts (${childSum}) must equal parent amount (${parent.amount})`,
        };
      }

      await db.delete(s.transactions).where(eq(s.transactions.parentId, p.parentId)).run();
      const results: string[] = [];
      for (const child of p.children) {
        const row = createTransaction({
          ...child,
          accountId: parent.accountId,
          date: child.date ?? parent.date,
          payee: child.payee ?? parent.payee ?? undefined,
          parentId: p.parentId,
          isChild: true,
          isParent: false,
        });
        await db.insert(s.transactions).values(row).run();
        results.push(row.id);
      }

      await db
        .update(s.transactions)
        .set({
          isParent: true,
          isChild: false,
          categoryId: null,
          updatedAt: nowIso(),
        })
        .where(eq(s.transactions.id, p.parentId))
        .run();

      return { ok: true, data: { childIds: results, parentId: p.parentId } };
    }

    default:
      return { ok: false, error: "Unknown transaction command" };
  }
}
