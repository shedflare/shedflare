import { eq, sql, and } from "drizzle-orm";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { moneyApi } from "../definitions";
import { createDb } from "../d1-access";
import { wrapHandler, validatedJson } from "./wrap-handler";
import {
  AccountsResponseSchema,
  AccountApiSchema,
  AccountTransactionsResponseSchema,
  AccountTagsResponseSchema,
} from "../../domain/schemas";
import * as s from "../../db/schema";
import { resolveTransactionFilter } from "../resolve-transaction-filter";

type Env = { MONEY_DB: D1Database };

export function createAccountsGroup(env: Env) {
  return HttpApiBuilder.group(moneyApi, "accounts", (handlers) =>
    handlers
      .handleRaw(
        "list",
        wrapHandler(async (): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const rows = await db.all<{
            id: string;
            name: string;
            offbudget: number;
            closed: number;
            sort_order: number;
            opening_balance: number;
            balance_current: number;
            last_reconciled: string | null;
          }>(
            sql`SELECT a.id, a.name, a.offbudget, a.closed, a.sort_order,
                  COALESCE(a.balance_current, 0) AS opening_balance,
                  COALESCE(a.balance_current, 0) + COALESCE(SUM(CASE WHEN t.is_child = 0 THEN t.amount ELSE 0 END), 0) AS balance_current,
                  a.last_reconciled
           FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
           GROUP BY a.id ORDER BY a.sort_order, a.name`,
          );
          return validatedJson(AccountsResponseSchema, {
            accounts: rows.map((r) => ({
              id: r.id,
              name: r.name,
              offbudget: r.offbudget === 1,
              closed: r.closed === 1,
              sortOrder: r.sort_order,
              openingBalance: Number(r.opening_balance),
              balanceCurrent: Number(r.balance_current),
              lastReconciled: r.last_reconciled,
            })),
          });
        }),
      )
      .handleRaw(
        "get",
        wrapHandler(async (req: Request): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const id = new URL(req.url).pathname.match(/\/api\/accounts\/([^/]+)$/)?.[1];
          if (!id)
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          const rows = await db
            .select({
              id: s.accounts.id,
              name: s.accounts.name,
              offbudget: s.accounts.offbudget,
              closed: s.accounts.closed,
              sortOrder: s.accounts.sortOrder,
              openingBalance: sql<number>`COALESCE(${s.accounts.balanceCurrent}, 0)`.mapWith(
                Number,
              ),
              balanceCurrent:
                sql<number>`COALESCE(${s.accounts.balanceCurrent}, 0) + COALESCE(SUM(CASE WHEN ${s.transactions.isChild} = 0 THEN ${s.transactions.amount} ELSE 0 END), 0)`.mapWith(
                  Number,
                ),
              lastReconciled: s.accounts.lastReconciled,
            })
            .from(s.accounts)
            .leftJoin(s.transactions, eq(s.transactions.accountId, s.accounts.id))
            .where(eq(s.accounts.id, id))
            .groupBy(s.accounts.id)
            .all();
          if (!rows[0])
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          return validatedJson(AccountApiSchema, rows[0]);
        }),
      )
      .handleRaw(
        "transactions",
        wrapHandler(async (req: Request): Promise<Response> => {
          const url = new URL(req.url);
          const accountId = url.pathname.match(/\/api\/accounts\/([^/]+)\/transactions$/)?.[1];
          const db = createDb(env.MONEY_DB);
          if (!accountId)
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });

          let whereClause = eq(s.transactions.accountId, accountId);
          const filter = await resolveTransactionFilter(db, url);
          if (filter.status === "invalid")
            return Response.json({ error: filter.error }, { status: 400 });
          const { filterSql } = filter;
          if (filterSql) whereClause = and(whereClause, filterSql) ?? whereClause;

          const rows = await db
            .select({
              id: s.transactions.id,
              accountId: s.transactions.accountId,
              categoryId: s.transactions.categoryId,
              amount: s.transactions.amount,
              payee: s.transactions.payee,
              notes: s.transactions.notes,
              date: s.transactions.date,
              cleared: s.transactions.cleared,
              reconciled: s.transactions.reconciled,
              importedDescription: s.transactions.importedDescription,
              startingBalanceFlag: s.transactions.startingBalanceFlag,
              sortOrder: s.transactions.sortOrder,
              isParent: s.transactions.isParent,
              isChild: s.transactions.isChild,
              parentId: s.transactions.parentId,
              transferId: s.transactions.transferId,
              scheduleId: s.transactions.scheduleId,
              createdAt: s.transactions.createdAt,
              updatedAt: s.transactions.updatedAt,
              categoryName: s.categories.name,
              scheduleName: s.schedules.name,
            })
            .from(s.transactions)
            .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
            .leftJoin(s.schedules, eq(s.transactions.scheduleId, s.schedules.id))
            .where(whereClause)
            .orderBy(sql`${s.transactions.date} DESC, ${s.transactions.createdAt} DESC`)
            .all();
          return validatedJson(AccountTransactionsResponseSchema, { transactions: rows });
        }),
      )
      .handleRaw(
        "tags",
        wrapHandler(async (req: Request): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const accountId = new URL(req.url).pathname.match(/\/api\/accounts\/([^/]+)\/tags$/)?.[1];
          if (!accountId)
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          const rows = await db
            .select({
              transactionId: s.transactionTags.transactionId,
              tagId: s.transactionTags.tagId,
              tagName: s.tags.name,
              tagColor: s.tags.color,
            })
            .from(s.transactionTags)
            .innerJoin(s.tags, eq(s.transactionTags.tagId, s.tags.id))
            .innerJoin(s.transactions, eq(s.transactionTags.transactionId, s.transactions.id))
            .where(eq(s.transactions.accountId, accountId))
            .orderBy(s.tags.name)
            .all();
          return validatedJson(AccountTagsResponseSchema, { transactionTags: rows });
        }),
      ),
  );
}
