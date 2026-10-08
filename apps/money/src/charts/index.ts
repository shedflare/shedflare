/**
 * Charts module — TanStack Charts components themed for Money.
 *
 * Usage:
 *   import { AreaChart, BarChart, DonutChart, BudgetBar } from "../charts";
 *   import type { TimeSeriesPoint, BarGroup, PieSlice, BudgetPair } from "../charts";
 *
 * Paints resolve against `.money-chart` custom properties in money.css.
 */

export { default as AreaChart } from "./AreaChart";
export { default as BarChart } from "./BarChart";
export { default as DonutChart } from "./DonutChart";
export { default as BudgetBar } from "./BudgetBar";

export type { AreaChartProps } from "./AreaChart";
export type { BarChartProps } from "./BarChart";
export type { DonutChartProps } from "./DonutChart";
export type { BudgetBarProps } from "./BudgetBar";

export {
  type TimeSeriesPoint,
  type BarGroup,
  type BarValue,
  type PieSlice,
  type BudgetPair,
  CHART_COLORS,
  CATEGORY_SLOTS,
  categoryColor,
  compactCentsFormatter,
} from "./types";
