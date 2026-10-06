import { eq, sql } from "drizzle-orm";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { moneyApi } from "../definitions";
import { createDb } from "../d1-access";
import { wrapHandler, validatedJson } from "./wrap-handler";
import { TransactionsResponseSchema } from "../../domain/schemas";
import * as s from "../../db/schema";
import { resolveTransactionFilter } from "../resolve-transaction-filter";

type Env = { MONEY_DB: D1Database };

export function createTransactionsGroup(env: Env) {
  return HttpApiBuilder.group(moneyApi, "transactions", (handlers) =>
    handlers.handleRaw(
      "list",
      wrapHandler(async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const db = createDb(env.MONEY_DB);
        const filter = await resolveTransactionFilter(db, url);
        if (filter.status === "invalid")
          return Response.json({ error: filter.error }, { status: 400 });
        const { filterSql } = filter;

        const query = db
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
            categoryName: sql<string | null>`${s.categories.name}`.as("category_name"),
            accountName: sql<string | null>`${s.accounts.name}`.as("account_name"),
            scheduleName: sql<string | null>`${s.schedules.name}`.as("schedule_name"),
          })
          .from(s.transactions)
          .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
          .leftJoin(s.accounts, eq(s.transactions.accountId, s.accounts.id))
          .leftJoin(s.schedules, eq(s.transactions.scheduleId, s.schedules.id))
          .orderBy(sql`${s.transactions.date} DESC, ${s.transactions.createdAt} DESC`);
        if (filterSql) query.where(filterSql);
        const rows = await query.all();

        const tagRows = await db
          .select({
            transactionId: s.transactionTags.transactionId,
            tagId: s.transactionTags.tagId,
            tagName: s.tags.name,
            tagColor: s.tags.color,
          })
          .from(s.transactionTags)
          .innerJoin(s.tags, eq(s.transactionTags.tagId, s.tags.id))
          .orderBy(s.tags.name)
          .all();

        return validatedJson(TransactionsResponseSchema, {
          transactions: rows,
          transactionTags: tagRows,
        });
      }),
    ),
  );
}
