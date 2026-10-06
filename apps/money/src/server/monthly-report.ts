import { and, eq, gte, lte, inArray } from "drizzle-orm";
import * as s from "../db/schema";
import type { Db } from "./d1-access";
import { monthBoundaries, prevMonthKey } from "../domain/types";
import { monthlyReport, validReportMonth } from "../domain/monthly-report";

export async function loadReportData(db: Db, start: string, end: string) {
  const [transactions, categories] = await Promise.all([
    db
      .select()
      .from(s.transactions)
      .where(and(gte(s.transactions.date, start), lte(s.transactions.date, end)))
      .all(),
    db.select().from(s.categories).all(),
  ]);
  const ids = new Set(transactions.map((row) => row.id));
  const missingParents = [
    ...new Set(
      transactions
        .filter((row) => row.isChild && row.parentId && !ids.has(row.parentId))
        .map((row) => row.parentId!),
    ),
  ];
  const additionalParents = missingParents.length
    ? await db
        .select({
          id: s.transactions.id,
          isParent: s.transactions.isParent,
          transferId: s.transactions.transferId,
          startingBalanceFlag: s.transactions.startingBalanceFlag,
        })
        .from(s.transactions)
        .where(inArray(s.transactions.id, missingParents))
        .all()
    : [];
  return { transactions, categories, additionalParents };
}

export async function computeMonthlyReport(db: Db, month: string) {
  if (!validReportMonth(month)) throw new Error("Choose a valid report month");
  const start = monthBoundaries(prevMonthKey(month)).start;
  const end = monthBoundaries(month).end;
  const [data, accounts] = await Promise.all([
    loadReportData(db, start, end),
    db
      .select({ id: s.accounts.id })
      .from(s.accounts)
      .where(eq(s.accounts.closed, false))
      .limit(1)
      .all(),
  ]);
  return monthlyReport(
    month,
    data.transactions,
    data.categories,
    accounts.length > 0,
    data.additionalParents,
  );
}
