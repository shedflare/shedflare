/**
 * Budget Engine — computes derived budget values from base data.
 *
 * Uses Drizzle query builder for typed queries and raw SQL for aggregates.
 * All functions are async — DrizzleD1Database is async.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./d1-access";
import { loadReportData } from "./monthly-report";
import { monthlyReport } from "../domain/monthly-report";
import {
  monthBoundaries,
  fromMonthInt,
  toMonthInt,
  castId,
  formatCalendarDate,
} from "../domain/types";
import type { CategoryBudgetRow, CategoryId, CategoryGroupId } from "../domain/types";

export interface BudgetRecalculationResult {
  month: number;
  toBudget: number;
  buffered: number;
  /** Last month's unassigned money plus what it held for this month. */
  fromLastMonth: number;
  /** Last month's uncovered overspending, taken out of this month's To assign. */
  overspentLastMonth: number;
  categories: CategoryBudgetRow[];
  categoryLeftovers: Array<{
    categoryId: string;
    leftover: number;
    leftoverPos: number;
    budgeted: number;
    spent: number;
  }>;
}

/** Live ledger balance: opening balance_current + non-child transactions. */
async function sumLiveBalances(
  db: Db,
  opts: { closed?: boolean; offbudget?: boolean } = {},
): Promise<number> {
  const closedClause =
    opts.closed === undefined ? sql`1=1` : sql`a.closed = ${opts.closed ? 1 : 0}`;
  const offbudgetClause =
    opts.offbudget === undefined ? sql`1=1` : sql`a.offbudget = ${opts.offbudget ? 1 : 0}`;
  const row = await db.get<{ total: number | null }>(
    sql`SELECT COALESCE(SUM(balance), 0) AS total
     FROM (
       SELECT COALESCE(a.balance_current, 0) + COALESCE(SUM(CASE WHEN t.is_child = 0 THEN t.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
       WHERE ${closedClause} AND ${offbudgetClause}
       GROUP BY a.id
     )`,
  );
  return Number(row?.total ?? 0);
}

// -- Category spending per month -------------------------------------------
/** Category activity through `month`, keyed by month int then category id. */
async function getCategorySpendingThrough(
  db: Db,
  month: number,
): Promise<Map<number, Map<string, number>>> {
  const { end } = monthBoundaries(fromMonthInt(month));

  const rows = await db.all<{ month: string; category_id: string; total: number }>(
    sql`SELECT substr(date, 1, 7) AS month, category_id, COALESCE(SUM(amount), 0) AS total
     FROM transactions t
     WHERE date <= ${end} AND category_id IS NOT NULL
       AND t.is_parent = 0
       AND (t.is_child = 0 OR EXISTS (
         SELECT 1 FROM transactions parent
         WHERE parent.id = t.parent_id AND parent.is_parent = 1
       ))
     GROUP BY substr(date, 1, 7), category_id`,
  );
  const result = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const key = toMonthInt(String(r.month));
    const byCategory = result.get(key) ?? new Map<string, number>();
    byCategory.set(String(r.category_id), Number(r.total));
    result.set(key, byCategory);
  }
  return result;
}

function nextMonthInt(month: number): number {
  return month % 100 === 12 ? month + 89 : month + 1;
}

// -- Main entry point: compute full budget for a month -----------------------
/**
 * Envelope budget for `month`, rolled forward from the first month with any budget data:
 * - category balances carry over month to month (overspending carries only when the
 *   category's carryover flag is set; otherwise it comes out of the next To assign);
 * - unassigned money carries over, and money held for next month is released into it.
 */
export async function computeMonthBudget(
  db: Db,
  month: number,
  monthKey?: string,
): Promise<BudgetRecalculationResult | null> {
  const mk = monthKey ?? fromMonthInt(month);
  const { end } = monthBoundaries(mk);

  const cats = await db.all<{
    id: string;
    name: string;
    is_income: number;
    group_id: string | null;
    hidden: number;
    goal_def: string | null;
    sort_order: number;
    group_name: string | null;
    group_sort_order: number | null;
  }>(
    sql`SELECT c.id, c.name, c.is_income, c.group_id, c.hidden, c.goal_def, c.sort_order,
            cg.name as group_name, cg.sort_order as group_sort_order
     FROM categories c
     LEFT JOIN category_groups cg ON c.group_id = cg.id
     ORDER BY cg.sort_order, c.sort_order`,
  );

  if (cats.length === 0) return null;

  const spending = await getCategorySpendingThrough(db, month);

  const budgetRows = await db.all<{
    month: number;
    category_id: string;
    amount: number;
    carryover: number;
  }>(sql`SELECT month, category_id, amount, carryover FROM budgets WHERE month <= ${month}`);
  const budgets = new Map<number, Map<string, { amount: number; carryover: boolean }>>();
  for (const b of budgetRows) {
    const key = Number(b.month);
    const byCategory =
      budgets.get(key) ?? new Map<string, { amount: number; carryover: boolean }>();
    byCategory.set(String(b.category_id), {
      amount: Number(b.amount),
      carryover: Boolean(b.carryover),
    });
    budgets.set(key, byCategory);
  }

  const bufferRows = await db.all<{ id: string; buffered: number }>(
    sql`SELECT id, buffered FROM budget_months WHERE id <= ${mk}`,
  );
  const buffers = new Map(bufferRows.map((r) => [toMonthInt(String(r.id)), Number(r.buffered)]));

  // Opening balances of on-budget accounts fund the month the account was added.
  const openingRows = await db.all<{ month: string; total: number | null }>(
    sql`SELECT substr(created_at, 1, 7) AS month, SUM(balance_current) AS total
     FROM accounts
     WHERE offbudget = 0 AND created_at <= ${`${end}T23:59:59.999Z`}
     GROUP BY substr(created_at, 1, 7)`,
  );
  const openings = new Map(
    openingRows.map((r) => [toMonthInt(String(r.month)), Number(r.total ?? 0)]),
  );

  const startMonth = Math.min(
    month,
    ...spending.keys(),
    ...budgets.keys(),
    ...buffers.keys(),
    ...openings.keys(),
  );

  const categoryRows: CategoryBudgetRow[] = [];
  const leftovers = new Map<string, number>();
  let toBudget = 0;
  let buffered = 0;
  let fromLastMonth = 0;
  let overspentLastMonth = 0;

  for (let current = startMonth; current <= month; current = nextMonthInt(current)) {
    const isTarget = current === month;
    const monthSpending = spending.get(current);
    const monthBudgets = budgets.get(current);
    fromLastMonth = toBudget + buffered;
    overspentLastMonth = 0;
    buffered = buffers.get(current) ?? 0;
    let totalIncome = 0;
    let totalBudgeted = 0;

    for (const cat of cats) {
      const categoryId = String(cat.id);
      const isIncome = Boolean(cat.is_income);
      const budget = monthBudgets?.get(categoryId);
      const budgeted = budget?.amount ?? 0;
      const carryover = budget?.carryover ?? false;
      const spent = monthSpending?.get(categoryId) ?? 0;
      totalBudgeted += budgeted;

      let leftover: number;
      if (isIncome) {
        // Income funds To assign; it doesn't accumulate as a category balance.
        totalIncome += spent;
        leftover = budgeted + spent;
      } else {
        const previous = leftovers.get(categoryId) ?? 0;
        if (previous < 0 && !carryover) overspentLastMonth -= previous;
        const carried = carryover ? previous : Math.max(previous, 0);
        leftover = budgeted + spent + carried;
        leftovers.set(categoryId, leftover);
      }

      // Visibility changes the list, while existing income and assignments still fund the budget.
      if (!isTarget || cat.hidden) continue;

      categoryRows.push({
        categoryId: castId<CategoryId>(categoryId),
        categoryName: String(cat.name),
        groupId: cat.group_id ? castId<CategoryGroupId>(cat.group_id) : null,
        groupName: cat.group_name ?? null,
        budgeted,
        spent,
        leftover,
        leftoverPos: Math.max(leftover, 0),
        carryover,
      });
    }

    toBudget =
      fromLastMonth +
      totalIncome +
      (openings.get(current) ?? 0) -
      overspentLastMonth -
      totalBudgeted -
      buffered;
  }

  return {
    month,
    toBudget,
    buffered,
    fromLastMonth,
    overspentLastMonth,
    categories: categoryRows,
    categoryLeftovers: categoryRows.map((c) => ({
      categoryId: c.categoryId,
      leftover: c.leftover,
      leftoverPos: c.leftoverPos,
      budgeted: c.budgeted,
      spent: c.spent,
    })),
  };
}

// -- Net worth ----------------------------------------------------------------
export async function computeNetWorth(db: Db): Promise<number> {
  return sumLiveBalances(db, { closed: false });
}

// -- Net worth history ---------------------------------------------------------
export async function computeNetWorthHistory(
  db: Db,
  monthsBack: number = 12,
): Promise<Array<{ month: string; netWorth: number }>> {
  const now = new Date();
  const monthKeys: string[] = [];

  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const windowStart = monthBoundaries(monthKeys[0]).start;

  // Opening balances + all activity before the history window = seed for first month.
  const openingRow = await db.get<{ total: number | null }>(
    sql`SELECT COALESCE(SUM(balance_current), 0) AS total FROM accounts WHERE closed = 0`,
  );
  const priorTxRow = await db.get<{ total: number | null }>(
    sql`SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE is_child = 0
       AND account_id IN (SELECT id FROM accounts WHERE closed = 0)
       AND date < ${windowStart}`,
  );
  let cumulative = Number(openingRow?.total ?? 0) + Number(priorTxRow?.total ?? 0);

  const monthlyTx = await db.all<{ month: string; total: number }>(
    sql`SELECT strftime('%Y-%m', date) AS month, COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE is_child = 0
       AND account_id IN (SELECT id FROM accounts WHERE closed = 0)
       AND date >= ${windowStart}
     GROUP BY strftime('%Y-%m', date)`,
  );

  const txByMonth = new Map<string, number>();
  for (const r of monthlyTx) txByMonth.set(r.month, Number(r.total));

  return monthKeys.map((mk) => {
    cumulative += txByMonth.get(mk) ?? 0;
    return { month: mk, netWorth: cumulative };
  });
}

// -- Cash flow ----------------------------------------------------------------
export async function computeCashFlow(
  db: Db,
  monthsBack: number = 12,
): Promise<Array<{ month: string; income: number; expense: number }>> {
  const now = new Date();
  const monthKeys: string[] = [];
  const monthStarts: string[] = [];
  const monthEnds: string[] = [];

  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthKeys.push(mk);
    const boundaries = monthBoundaries(mk);
    monthStarts.push(boundaries.start);
    monthEnds.push(boundaries.end);
  }

  const data = await loadReportData(db, monthStarts[0]!, monthEnds[monthEnds.length - 1]!);
  return monthKeys.map((month) => {
    const report = monthlyReport(
      month,
      data.transactions,
      data.categories,
      false,
      data.additionalParents,
    );
    return { month, income: report.income, expense: report.expense };
  });
}

// -- Spending by category -----------------------------------------------------
export async function computeSpendingByCategory(
  db: Db,
  startDate: string,
  endDate: string,
): Promise<
  Array<{ categoryId: string; categoryName: string; amount: number; groupName: string | null }>
> {
  const rows = await db.all<{
    id: string;
    name: string;
    group_name: string | null;
    total: number;
  }>(
    sql`SELECT c.id, c.name, cg.name as group_name, COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     LEFT JOIN category_groups cg ON c.group_id = cg.id
     WHERE t.date >= ${startDate} AND t.date <= ${endDate}
       AND t.is_child = 0 AND c.hidden = 0
     GROUP BY c.id
     ORDER BY total DESC`,
  );
  return rows.map((r) => ({
    categoryId: String(r.id),
    categoryName: String(r.name),
    amount: Number(r.total),
    groupName: r.group_name ?? null,
  }));
}

// -- Daily income/expense for calendar heatmap ---------------------------------
export async function computeDailyHeatmap(
  db: Db,
  monthKey: string,
): Promise<{ income: Record<string, number>; expense: Record<string, number> }> {
  const boundaries = monthBoundaries(monthKey);
  const rows = await db.all<{ date: string; income: number; expense: number }>(
    sql`SELECT t.date,
       COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END), 0) AS expense
     FROM transactions t
     WHERE t.date >= ${boundaries.start} AND t.date <= ${boundaries.end}
       AND t.is_child = 0
     GROUP BY t.date
     ORDER BY t.date`,
  );
  const income: Record<string, number> = {};
  const expense: Record<string, number> = {};
  for (const r of rows) {
    income[String(r.date)] = Number(r.income);
    expense[String(r.date)] = Number(r.expense);
  }
  return { income, expense };
}

// -- Age of money ------------------------------------------------------------
export async function computeAgeOfMoney(db: Db): Promise<number | null> {
  const currentCash = await sumLiveBalances(db, { closed: false, offbudget: false });
  if (currentCash <= 0) return null;

  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 90);
  const startDate = formatCalendarDate(start);
  const endDate = formatCalendarDate(end);

  const spendingRow = await db.get<{ total: number | null }>(
    sql`SELECT COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.date >= ${startDate} AND t.date <= ${endDate}
       AND c.is_income = 0 AND t.is_child = 0`,
  );
  const totalSpending = Math.abs(Number(spendingRow?.total ?? 0));
  const avgDaily = totalSpending / 90;
  if (avgDaily <= 0) return null;

  return Math.round(currentCash / avgDaily);
}

// -- Crossover projection (FI-RE) --------------------------------------------
export interface CrossoverDataPoint {
  month: string;
  balance: number;
  investmentIncome: number;
  expenses: number;
  isProjection: boolean;
}

export interface CrossoverResult {
  currentBalance: number;
  targetNestEgg: number;
  medianExpense: number;
  savingsRate: number;
  yearsToRetire: number | null;
  yearsToRetireFormatted: string;
  dataPoints: CrossoverDataPoint[];
}

export async function computeCrossoverProjection(db: Db): Promise<CrossoverResult | null> {
  const now = new Date();
  const monthsBack = 12;

  const monthlyData: Array<{ month: string; income: number; expense: number }> = [];
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const boundaries = monthBoundaries(mk);

    const incomeRow = await db.get<{ total: number | null }>(
      sql`SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.date >= ${boundaries.start} AND t.date <= ${boundaries.end}
         AND c.is_income = 1 AND t.is_child = 0`,
    );
    const expenseRow = await db.get<{ total: number | null }>(
      sql`SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.date >= ${boundaries.start} AND t.date <= ${boundaries.end}
         AND c.is_income = 0 AND t.is_child = 0`,
    );
    monthlyData.push({
      month: mk,
      income: Math.abs(Number(incomeRow?.total ?? 0)),
      expense: Math.abs(Number(expenseRow?.total ?? 0)),
    });
  }

  if (monthlyData.length < 3) return null;

  const expenses = monthlyData.map((m) => m.expense).sort((a, b) => a - b);
  const medianExpense =
    expenses.length % 2 === 0
      ? (expenses[expenses.length / 2 - 1] + expenses[expenses.length / 2]) / 2
      : expenses[Math.floor(expenses.length / 2)];

  const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0);
  const totalExpense = monthlyData.reduce((s, m) => s + m.expense, 0);
  const avgMonthlySavings = (totalIncome - totalExpense) / monthlyData.length;
  const savingsRate = totalIncome > 0 ? (totalIncome - totalExpense) / totalIncome : 0;

  const currentBalance = await sumLiveBalances(db, { closed: false, offbudget: false });

  const annualExpense = medianExpense * 12;
  const targetNestEgg = annualExpense / 0.04;

  const monthlyReturn = 0.05 / 12;
  const projectionMonths = 600;
  let projectedBalance = currentBalance;
  const dataPoints: CrossoverDataPoint[] = [];

  for (const m of monthlyData) {
    dataPoints.push({
      month: m.month,
      balance: projectedBalance,
      investmentIncome: Math.round(projectedBalance * (0.04 / 12)),
      expenses: m.expense,
      isProjection: false,
    });
    projectedBalance += m.income - m.expense;
  }

  let crossoverMonth: number | null = null;
  for (let i = 1; i <= projectionMonths; i++) {
    projectedBalance += avgMonthlySavings;
    projectedBalance *= 1 + monthlyReturn;

    const monthlyIncome = Math.round(projectedBalance * (0.04 / 12));
    const cursor = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthLabel = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;

    dataPoints.push({
      month: monthLabel,
      balance: Math.round(projectedBalance),
      investmentIncome: monthlyIncome,
      expenses: Math.round(medianExpense),
      isProjection: true,
    });

    if (monthlyIncome >= medianExpense && crossoverMonth === null) {
      crossoverMonth = i;
      break;
    }
  }

  const yearsToRetire = crossoverMonth !== null ? crossoverMonth / 12 : null;
  const yearsToRetireFormatted =
    yearsToRetire !== null
      ? `${Math.floor(yearsToRetire)}y ${Math.round((yearsToRetire % 1) * 12)}m`
      : "50y+";

  return {
    currentBalance,
    targetNestEgg,
    medianExpense,
    savingsRate,
    yearsToRetire,
    yearsToRetireFormatted,
    dataPoints,
  };
}
