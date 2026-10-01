import { eq, and, sql } from "drizzle-orm";
import type { Db } from "../d1-access";
import * as s from "../../db/schema";
import { createAccount, createTransaction } from "../../domain/factories";
import { nowIso } from "../../domain/types";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";

type AccountCommand =
  | "create_account"
  | "update_account"
  | "delete_account"
  | "close_account"
  | "reopen_account"
  | "reorder_accounts"
  | "reconcile_account"
  | "update_exchange_rate";

type AccountInvocation = Extract<CommandInvocation, { commandType: AccountCommand }>;

export async function handleAccountCommands(
  command: AccountInvocation,
  db: Db,
): Promise<CommandResult> {
  switch (command.commandType) {
    case "reconcile_account": {
      const p = command.payload;
      if (!Number.isSafeInteger(p.expectedBalance) || !Number.isSafeInteger(p.statementBalance))
        return { ok: false, error: "Enter a valid statement balance" };
      const [account] = await db
        .select()
        .from(s.accounts)
        .where(eq(s.accounts.id, p.accountId))
        .all();
      if (!account || account.closed) return { ok: false, error: "Choose an open account" };
      const row = await db.get<{ balance: number }>(
        sql`SELECT COALESCE(${account.balanceCurrent}, 0) + COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE account_id = ${account.id} AND is_child = 0 AND cleared = 1`,
      );
      const balance = Number(row?.balance ?? 0);
      if (balance !== p.expectedBalance)
        return {
          ok: false,
          error: "The account balance changed. Try again with the refreshed balance.",
        };
      const difference = p.statementBalance - balance;
      if (!Number.isSafeInteger(difference))
        return { ok: false, error: "The adjustment is too large" };
      const candidates = await db
        .select({ id: s.transactions.id })
        .from(s.transactions)
        .where(
          and(
            eq(s.transactions.accountId, account.id),
            eq(s.transactions.cleared, true),
            eq(s.transactions.reconciled, false),
            eq(s.transactions.isChild, false),
          ),
        )
        .all();
      const now = nowIso();
      const adjustment =
        difference === 0
          ? null
          : createTransaction({
              accountId: account.id,
              date: now.slice(0, 10),
              amount: difference,
              payee: "Balance adjustment",
              notes: "Account reconciliation",
              cleared: true,
              reconciled: true,
            });
      const statements = [
        db
          .update(s.transactions)
          .set({ reconciled: true, updatedAt: now })
          .where(
            and(
              eq(s.transactions.accountId, account.id),
              eq(s.transactions.cleared, true),
              eq(s.transactions.isChild, false),
            ),
          ),
        db
          .update(s.accounts)
          .set({ lastReconciled: now, updatedAt: now })
          .where(eq(s.accounts.id, account.id)),
      ] as const;
      if (adjustment) await db.batch([...statements, db.insert(s.transactions).values(adjustment)]);
      else await db.batch(statements);
      return { ok: true, data: { id: account.id, count: candidates.length } };
    }
    case "create_account": {
      const p = command.payload;
      const row = createAccount({
        name: p.name,
        offBudget: p.offBudget,
        balance: p.balance,
      });
      await db.insert(s.accounts).values(row).run();
      return { ok: true, data: { id: row.id } };
    }

    case "update_account": {
      const p = command.payload;
      const [existing] = await db.select().from(s.accounts).where(eq(s.accounts.id, p.id)).all();
      if (!existing) return { ok: false, error: "Account not found" };

      const set: Partial<typeof s.accounts.$inferInsert> = { updatedAt: nowIso() };
      if (p.name !== undefined) set.name = p.name;
      if (p.offBudget !== undefined) set.offbudget = p.offBudget;
      if (p.lastReconciled !== undefined) set.lastReconciled = p.lastReconciled;

      await db.update(s.accounts).set(set).where(eq(s.accounts.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "delete_account": {
      const p = command.payload;
      await db.delete(s.accounts).where(eq(s.accounts.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "close_account": {
      const p = command.payload;
      await db
        .update(s.accounts)
        .set({ closed: true, updatedAt: nowIso() })
        .where(eq(s.accounts.id, p.id))
        .run();
      return { ok: true, data: { id: p.id } };
    }

    case "reopen_account": {
      const p = command.payload;
      await db
        .update(s.accounts)
        .set({ closed: false, updatedAt: nowIso() })
        .where(eq(s.accounts.id, p.id))
        .run();
      return { ok: true, data: { id: p.id } };
    }

    case "reorder_accounts": {
      const p = command.payload;
      const now = nowIso();
      for (let i = 0; i < p.ids.length; i++) {
        await db
          .update(s.accounts)
          .set({ sortOrder: i, updatedAt: now })
          .where(eq(s.accounts.id, p.ids[i]))
          .run();
      }
      return { ok: true, data: { count: p.ids.length } };
    }

    case "update_exchange_rate": {
      const p = command.payload;
      await db
        .insert(s.exchangeRates)
        .values({
          id: "latest",
          usdToIdr: p.usdToIdr,
          updatedAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: s.exchangeRates.id,
          set: { usdToIdr: p.usdToIdr, updatedAt: nowIso() },
        })
        .run();
      return { ok: true, data: {} };
    }

    default:
      return { ok: false, error: "Unknown account command" };
  }
}
