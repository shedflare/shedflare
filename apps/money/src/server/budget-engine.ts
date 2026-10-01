/**
 * Budget Engine — computes derived budget values from base data.
 *
 * Uses Drizzle query builder for typed queries and raw SQL for aggregates.
 * All functions are async — DrizzleD1Database is async.
 */
import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import * as tables from "../db/schema";
import type { Db } from "./d1-access";
import {
  monthBoundaries,
  prevMonthKey,
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
  categories: CategoryBudgetRow[];
  categoryLeftovers: Array<{
    categoryId: string;
    leftover: number;
    leftoverPos: number;
    budgeted: number;
    spent: number;
  }>;
}

interface LeftoverInfo {
  leftover: number;
  leftoverPos: number;
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
async function getCategorySpending(
  db: Db,
  month: number,
): Promise<Array<{ categoryId: string; spent: number }>> {
  const { start, end } = monthBoundaries(fromMonthInt(month));

  const rows = await db.all<{ category_id: string; total: number }>(
    sql`SELECT category_id, COALESCE(SUM(amount), 0) AS total
     FROM transactions t
     WHERE date >= ${start} AND date <= ${end} AND category_id IS NOT NULL
       AND t.is_parent = 0
       AND (t.is_child = 0 OR EXISTS (
         SELECT 1 FROM transactions parent
         WHERE parent.id = t.parent_id AND parent.is_parent = 1
       ))
     GROUP BY category_id`,
  );
  return rows.map((r) => ({ categoryId: String(r.category_id), spent: Number(r.total) }));
}

// -- Per-category leftovers for a given month -------------------------------
async function getMonthLeftovers(
  db: Db,
  month: number,
  _monthKey: string,
): Promise<Map<string, LeftoverInfo>> {
  const result = new Map<string, LeftoverInfo>();
  const cats = await db.all<{ id: string }>(sql`SELECT id FROM categories WHERE hidden = 0`);
  const spending = await getCategorySpending(db, month);
  const spendingMap = new Map(spending.map((s) => [s.categoryId, s.spent]));

  const budgetRows = await db.all<{
    category_id: string;
    amount: number;
    carryover: number;
  }>(sql`SELECT category_id, amount, carryover FROM budgets WHERE month = ${month}`);

  for (const cat of cats) {
    const categoryId = String(cat.id);
    const budget = budgetRows.find((b) => String(b.category_id) === categoryId);
    const budgeted = budget ? Number(budget.amount) : 0;
    const spent = spendingMap.get(categoryId) ?? 0;
    const leftover = budgeted + spent;
    const leftoverPos = Math.max(leftover, 0);
    result.set(categoryId, { leftover, leftoverPos });
  }
  return result;
}

// -- Main entry point: compute full budget for a month -----------------------
export async function computeMonthBudget(
  db: Db,
  month: number,
  monthKey?: string,
): Promise<BudgetRecalculationResult | null> {
  const mk = monthKey ?? fromMonthInt(month);

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

  const spending = await getCategorySpending(db, month);
  const spendingMap = new Map(spending.map((s) => [s.categoryId, s.spent]));

  const budgetRows = await db.all<{
    category_id: string;
    amount: number;
    carryover: number;
  }>(sql`SELECT category_id, amount, carryover FROM budgets WHERE month = ${month}`);
  const budgetMap = new Map(
    budgetRows.map((b) => [
      String(b.category_id),
      { amount: Number(b.amount), carryover: Boolean(b.carryover) },
    ]),
  );

  const prevMk = prevMonthKey(mk);
  const prevMonth = toMonthInt(prevMk);
  const prevLeftovers = await getMonthLeftovers(db, prevMonth, prevMk);

  const budgetMonthRow = await db.get<{ id: string; buffered: number }>(
    sql`SELECT id, buffered FROM budget_months WHERE id = ${mk}`,
  );
  const buffered = Number(budgetMonthRow?.buffered ?? 0);

  const categoryRows: CategoryBudgetRow[] = [];
  let totalIncome = 0;
  let totalBudgeted = 0;

  for (const cat of cats) {
    const categoryId = String(cat.id);
    const isIncome = Boolean(cat.is_income);
    const budget = budgetMap.get(categoryId);
    const budgeted = budget?.amount ?? 0;
    const carryover = budget?.carryover ?? false;
    const spent = spendingMap.get(categoryId) ?? 0;
    const prevLeftover = prevLeftovers.get(categoryId);
    const prevLeftoverVal = prevLeftover?.leftover ?? 0;
    const prevLeftoverPosVal = prevLeftover?.leftoverPos ?? 0;

    const carryoverAmount = carryover ? prevLeftoverVal : Math.max(prevLeftoverPosVal, 0);
    const leftover = budgeted + spent + carryoverAmount;
    const leftoverPos = Math.max(leftover, 0);

    if (isIncome) totalIncome += spent;
    totalBudgeted += budgeted;

    // Visibility changes the list, while existing income and assignments still fund the budget.
    if (cat.hidden) continue;

    categoryRows.push({
      categoryId: castId<CategoryId>(categoryId),
      categoryName: String(cat.name),
      groupId: cat.group_id ? castId<CategoryGroupId>(cat.group_id) : null,
      groupName: cat.group_name ?? null,
      budgeted,
      spent,
      leftover,
      leftoverPos,
      carryover,
    });
  }

  const { start, end } = monthBoundaries(mk);
  const [opening] = await db
    .select({ total: sum(tables.accounts.balanceCurrent) })
    .from(tables.accounts)
    .where(
      and(
        eq(tables.accounts.offbudget, false),
        gte(tables.accounts.createdAt, start),
        lte(tables.accounts.createdAt, `${end}T23:59:59.999Z`),
      ),
    )
    .all();
  const toBudget = totalIncome + Number(opening?.total ?? 0) - totalBudgeted - buffered;

  return {
    month,
    toBudget,
    buffered,
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

  const rows = await db.all<{ month: string; is_income: number; total: number }>(
    sql`SELECT strftime('%Y-%m', t.date) AS month, c.is_income, COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.date >= ${monthStarts[0]} AND t.date <= ${monthEnds[monthEnds.length - 1]}
       AND t.is_child = 0
     GROUP BY strftime('%Y-%m', t.date), c.is_income`,
  );

  const incomeMap = new Map<string, number>();
  const expenseMap = new Map<string, number>();
  for (const r of rows) {
    if (r.is_income === 1) incomeMap.set(r.month, Number(r.total));
    else expenseMap.set(r.month, Number(r.total));
  }

  return monthKeys.map((mk) => ({
    month: mk,
    income: Math.abs(incomeMap.get(mk) ?? 0),
    expense: Math.abs(expenseMap.get(mk) ?? 0),
  }));
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
