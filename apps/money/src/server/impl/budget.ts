import { sql } from "drizzle-orm";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { moneyApi } from "../definitions";
import { createDb } from "../d1-access";
import { wrapHandler, validatedJson } from "./wrap-handler";
import { BudgetOverviewResponseSchema, MonthBudgetResponseSchema } from "../../domain/schemas";
import { computeMonthBudget } from "../budget-engine";
import { monthBoundaries } from "../../domain/types";

type Env = { MONEY_DB: D1Database };

export function createBudgetGroup(env: Env) {
  return HttpApiBuilder.group(moneyApi, "budget", (handlers) =>
    handlers
      .handleRaw(
        "overview",
        wrapHandler(async (): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const netWorthRow = await db.get<{ total: number }>(
            sql`SELECT COALESCE(SUM(balance), 0) AS total
           FROM (SELECT COALESCE(a.balance_current, 0) + COALESCE(SUM(CASE WHEN t.is_child = 0 THEN t.amount ELSE 0 END), 0) AS balance
           FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
           WHERE a.closed = 0 GROUP BY a.id)`,
          );
          const onBudgetRow = await db.get<{ total: number }>(
            sql`SELECT COALESCE(SUM(balance), 0) AS total
           FROM (SELECT COALESCE(a.balance_current, 0) + COALESCE(SUM(CASE WHEN t.is_child = 0 THEN t.amount ELSE 0 END), 0) AS balance
           FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
           WHERE a.offbudget = 0 AND a.closed = 0 GROUP BY a.id)`,
          );
          const accountCountRow = await db.get<{ total: number }>(
            sql`SELECT COUNT(*) AS total FROM accounts WHERE closed = 0`,
          );
          const now = new Date();
          const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
          const { start: startDate, end: endDate } = monthBoundaries(monthKey);
          const incomeRow = await db.get<{ total: number }>(
            sql`SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t
           JOIN categories c ON t.category_id = c.id
           WHERE t.date >= ${startDate} AND t.date <= ${endDate} AND c.is_income = 1 AND t.is_child = 0`,
          );
          const expenseRow = await db.get<{ total: number }>(
            sql`SELECT COALESCE(SUM(t.amount), 0) as total FROM transactions t
           JOIN categories c ON t.category_id = c.id
           WHERE t.date >= ${startDate} AND t.date <= ${endDate} AND c.is_income = 0 AND t.is_child = 0`,
          );
          return validatedJson(BudgetOverviewResponseSchema, {
            netWorth: netWorthRow?.total ?? 0,
            onBudget: onBudgetRow?.total ?? 0,
            accountCount: Number(accountCountRow?.total ?? 0),
            income: incomeRow?.total ?? 0,
            expense: expenseRow?.total ?? 0,
          });
        }),
      )
      .handleRaw(
        "month",
        wrapHandler(async (req: Request): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const month = parseInt(
            new URL(req.url).pathname.match(/\/api\/budget\/(\d{6})$/)?.[1] ?? "0",
          );
          const result = await computeMonthBudget(db, month);
          return validatedJson(
            MonthBudgetResponseSchema,
            result ?? {
              categories: [],
              toBudget: 0,
              buffered: 0,
              fromLastMonth: 0,
              overspentLastMonth: 0,
              month,
            },
          );
        }),
      ),
  );
}
