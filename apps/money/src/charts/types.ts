// ---------------------------------------------------------------------------
// Shared data shapes and paint tokens for the TanStack chart components
// ---------------------------------------------------------------------------

/** A single point on a time-series line/area chart */
export interface TimeSeriesPoint {
  date: string; // ISO date or "YYYY-MM"
  value: number; // in cents
  label?: string;
}

/** One bar group in a bar chart */
export interface BarGroup {
  category: string;
  values: BarValue[];
}

export interface BarValue {
  label: string;
  value: number; // in cents
  color?: string;
}

/** One slice in a donut/pie chart */
export interface PieSlice {
  label: string;
  value: number; // in cents (absolute, positive)
  color?: string;
}

/** One row in a budget vs actuals chart */
export interface BudgetPair {
  category: string;
  budgeted: number; // in cents
  actual: number; // in cents (spent)
  color?: string;
}

/**
 * Chart paints resolve against `.money-chart` custom properties in money.css,
 * which carry validated light and dark steps. Text never uses these colors.
 */
export const CHART_COLORS = {
  income: "var(--chart-income)",
  spending: "var(--chart-spending)",
  balance: "var(--accent)",
  budget: "var(--chart-budget)",
} as const;

/** Categorical slots in fixed order; a ninth series folds into "Other". */
export const CATEGORY_SLOTS = 8;

export function categoryColor(index: number): string {
  return `var(--ts-chart-${(index % CATEGORY_SLOTS) + 1})`;
}

/** Compact currency for axis ticks, e.g. "$12K" or "Rp1,2 jt". */
export function compactCentsFormatter(code: string, locale: string): (cents: number) => string {
  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  return (cents) => format.format(cents / 100);
}
