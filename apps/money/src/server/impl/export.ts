import { and, eq, desc, sql } from "drizzle-orm";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { moneyApi } from "../definitions";
import { createDb } from "../d1-access";
import { wrapHandler } from "./wrap-handler";
import { transactionCsv } from "../../domain/transaction-csv";
import * as s from "../../db/schema";
type Env = { MONEY_DB: D1Database };
export function createExportGroup(env: Env) {
  return HttpApiBuilder.group(moneyApi, "export", (handlers) =>
    handlers.handleRaw(
      "csv",
      wrapHandler(async (request: Request): Promise<Response> => {
        const accountId = new URL(request.url).searchParams.get("accountId");
        const rows = await createDb(env.MONEY_DB)
          .select({
            date: s.transactions.date,
            amount: s.transactions.amount,
            payee: s.transactions.payee,
            category: sql<string | null>`${s.categories.name}`.as("category"),
            notes: s.transactions.notes,
            account: sql<string | null>`${s.accounts.name}`.as("account"),
          })
          .from(s.transactions)
          .leftJoin(s.categories, eq(s.transactions.categoryId, s.categories.id))
          .leftJoin(s.accounts, eq(s.transactions.accountId, s.accounts.id))
          .where(
            and(
              eq(s.transactions.isChild, false),
              accountId ? eq(s.transactions.accountId, accountId) : undefined,
            ),
          )
          .orderBy(desc(s.transactions.date))
          .all();
        return new Response(transactionCsv(rows), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="shedflare-export.csv"',
          },
        });
      }),
    ),
  );
}
