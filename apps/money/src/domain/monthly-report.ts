import * as Schema from "effect/Schema";
import { CategoryIconSchema } from "./category-icons";
import { monthBoundaries, prevMonthKey } from "./types";
import type { Transaction, Category } from "../db/schema";

export const MonthlyReportSchema = Schema.Struct({
  month: Schema.String,
  income: Schema.Number,
  expense: Schema.Number,
  transactionCount: Schema.Number,
  hasAccounts: Schema.Boolean,
  previous: Schema.Struct({
    month: Schema.String,
    income: Schema.Number,
    expense: Schema.Number,
    transactionCount: Schema.Number,
  }),
  /** Days of the selected month with activity, ascending; same rules as the month totals. */
  days: Schema.Array(
    Schema.Struct({ date: Schema.String, income: Schema.Number, expense: Schema.Number }),
  ),
  categories: Schema.Array(
    Schema.Struct({
      categoryId: Schema.NullOr(Schema.String),
      name: Schema.String,
      icon: Schema.NullOr(CategoryIconSchema),
      amount: Schema.Number,
      previousAmount: Schema.Number,
    }),
  ),
});
export type MonthlyReport = Schema.Schema.Type<typeof MonthlyReportSchema>;
export function validReportMonth(month: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1000;
}
export type ReportTransaction = Pick<
  Transaction,
  | "id"
  | "categoryId"
  | "date"
  | "amount"
  | "isChild"
  | "isParent"
  | "parentId"
  | "transferId"
  | "startingBalanceFlag"
>;
export type ReportCategory = Pick<Category, "id" | "name" | "icon" | "isIncome">;

/** Refunds reduce category spending. Split children count once; transfers and opening entries stay out. */
export function monthlyReport(
  month: string,
  transactions: readonly ReportTransaction[],
  definitions: readonly ReportCategory[],
  hasAccounts: boolean,
  additionalParents: readonly Pick<
    Transaction,
    "id" | "isParent" | "transferId" | "startingBalanceFlag"
  >[] = [],
): MonthlyReport {
  if (!validReportMonth(month)) throw new Error("Choose a valid report month");
  const previousMonth = prevMonthKey(month);
  const definitionMap = new Map(definitions.map((row) => [row.id, row]));
  const parents = new Set(
    [...transactions, ...additionalParents]
      .filter((row) => row.isParent && !row.transferId && !row.startingBalanceFlag)
      .map((row) => row.id),
  );
  function period(key: string) {
    const boundaries = monthBoundaries(key);
    const rows = transactions.filter(
      (row) =>
        row.date >= boundaries.start &&
        row.date <= boundaries.end &&
        !row.transferId &&
        !row.startingBalanceFlag,
    );
    const spending = new Map<string | null, number>();
    let income = 0;
    let expense = 0;
    const activityIds = new Set<string>();
    const days = new Map<string, { income: number; expense: number }>();
    for (const row of rows) {
      if (row.isParent || (row.isChild && (!row.parentId || !parents.has(row.parentId)))) continue;
      activityIds.add(row.isChild ? row.parentId! : row.id);
      const category = row.categoryId ? definitionMap.get(row.categoryId) : undefined;
      const day = days.get(row.date) ?? { income: 0, expense: 0 };
      days.set(row.date, day);
      if (category?.isIncome || (!category && row.amount > 0)) {
        income += row.amount;
        day.income += row.amount;
      } else {
        expense -= row.amount;
        day.expense -= row.amount;
        const id = category?.id ?? null;
        spending.set(id, (spending.get(id) ?? 0) - row.amount);
      }
    }
    return { income, expense, transactionCount: activityIds.size, spending, days };
  }
  const current = period(month);
  const previous = period(previousMonth);
  const categoryIds = new Set([...current.spending.keys(), ...previous.spending.keys()]);
  return {
    month,
    income: current.income,
    expense: current.expense,
    transactionCount: current.transactionCount,
    hasAccounts,
    previous: {
      month: previousMonth,
      income: previous.income,
      expense: previous.expense,
      transactionCount: previous.transactionCount,
    },
    days: [...current.days]
      .map(([date, totals]) => ({ date, ...totals }))
      .filter((row) => row.income !== 0 || row.expense !== 0)
      .sort((a, b) => a.date.localeCompare(b.date)),
    categories: [...categoryIds]
      .map((categoryId) => {
        const category = categoryId ? definitionMap.get(categoryId) : undefined;
        return {
          categoryId,
          name: category?.name ?? "Uncategorized",
          icon: category?.icon ?? null,
          amount: current.spending.get(categoryId) ?? 0,
          previousAmount: previous.spending.get(categoryId) ?? 0,
        };
      })
      .filter((row) => row.amount !== 0 || row.previousAmount !== 0)
      .sort(
        (a, b) =>
          b.amount - a.amount ||
          b.previousAmount - a.previousAmount ||
          a.name.localeCompare(b.name),
      ),
  };
}
