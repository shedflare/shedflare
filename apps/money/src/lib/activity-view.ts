import type { TransactionsResponse } from "../domain/schemas-client";

type Transaction = TransactionsResponse["transactions"][number];
export function activityEntries(rows: readonly Transaction[]) {
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter((row) => !row.isChild || !row.parentId || !ids.has(row.parentId));
}
export function filterActivity(
  rows: readonly Transaction[],
  filter: {
    month: string | null;
    category?: string;
    account?: string;
    view?: string;
    query: string;
  },
) {
  const query = filter.query.trim().toLocaleLowerCase();
  const matches = rows.filter((row) => {
    if (filter.month && row.date.slice(0, 7) !== filter.month) return false;
    if (filter.category && row.categoryId !== filter.category) return false;
    if (filter.account && row.accountId !== filter.account) return false;
    if (
      filter.view === "uncategorized" &&
      (row.categoryId || row.isParent || row.transferId || row.startingBalanceFlag)
    )
      return false;
    if (filter.view === "expenses" && row.amount >= 0) return false;
    if (filter.view === "income" && row.amount <= 0) return false;
    return (
      !query ||
      [row.payee, row.notes, row.categoryName, row.accountName, row.date].some((value) =>
        value?.toLocaleLowerCase().includes(query),
      )
    );
  });
  const parentIds = new Set(matches.filter((row) => row.isChild).map((row) => row.parentId));
  const ids = new Set(matches.map((row) => row.id));
  return rows.filter((row) => ids.has(row.id) || parentIds.has(row.id));
}
function countedActivity(rows: readonly Transaction[], categoryFiltered: boolean) {
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter(
    (row) =>
      !row.transferId &&
      !row.startingBalanceFlag &&
      (categoryFiltered ? !row.isParent : !row.isChild || !row.parentId || !ids.has(row.parentId)),
  );
}
export function activityTotals(rows: readonly Transaction[], categoryFiltered: boolean) {
  return countedActivity(rows, categoryFiltered).reduce(
    (totals, row) => ({
      income: totals.income + Math.max(0, row.amount),
      expense: totals.expense + Math.max(0, -row.amount),
    }),
    { income: 0, expense: 0 },
  );
}
/** Per-date totals matching `activityTotals`, ascending by date. */
export function dailyActivityTotals(rows: readonly Transaction[], categoryFiltered: boolean) {
  const days = new Map<string, { date: string; income: number; expense: number }>();
  for (const row of countedActivity(rows, categoryFiltered)) {
    const day = days.get(row.date) ?? { date: row.date, income: 0, expense: 0 };
    day.income += Math.max(0, row.amount);
    day.expense += Math.max(0, -row.amount);
    days.set(row.date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
