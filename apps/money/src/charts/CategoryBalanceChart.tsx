import { createMemo, Show } from "solid-js";
import { areaY, defineChart, dot, lineY, ruleY, type ChartPoint } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { Chart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import { useCurrency } from "../lib/currency";
import type { BalancePoint, CategoryBalanceSeries } from "../lib/category-balance";
import { CHART_COLORS, compactCentsFormatter } from "./types";

export interface CategoryBalanceChartProps {
  series: CategoryBalanceSeries;
  /** Accessible chart name */
  label: string;
  /** Format a calendar date for tooltip titles */
  formatDay: (date: string) => string;
  height?: number;
}

/** A category's available balance through the month, continued dashed by scheduled payments. */
export default function CategoryBalanceChart(props: CategoryBalanceChartProps) {
  const fmt = useCurrency();
  const definition = createMemo(() => {
    const { actual, projected, days } = props.series;
    const money = fmt();
    const compact = compactCentsFormatter(money.code, money.locale);
    const formatDay = props.formatDay;
    const tick = new Intl.DateTimeFormat(money.locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const dateOf = (day: number) =>
      (actual[0] ?? projected[0]).date.slice(0, 8) + String(Math.round(day)).padStart(2, "0");
    const values = [...actual, ...projected].map((point) => point.value);
    const crossesZero = Math.min(...values) < 0 && Math.max(...values) > 0;
    const due = projected.filter((point) => point.scheduled.length);
    const color = CHART_COLORS.balance;
    return defineChart({
      chart: ({ width }) => ({
        marks: [
          areaY(actual, { x: "day", y: "value", fill: color, fillOpacity: 0.12 }),
          ...(crossesZero ? [ruleY([0], { stroke: "currentColor", strokeOpacity: 0.4 })] : []),
          lineY(actual, { x: "day", y: "value", stroke: color, strokeWidth: 2 }),
          lineY(projected, {
            x: "day",
            y: "value",
            stroke: color,
            strokeWidth: 2,
            strokeDasharray: "4 4",
            strokeOpacity: 0.7,
          }),
          dot(due, { x: "day", y: "value", r: 4, fill: color, stroke: "var(--bg-card)" }),
          crosshair({ x: true, y: false }),
        ],
        scales: {
          x: {
            scale: scaleLinear().domain([1, days]),
            axis: {
              line: false,
              ticks: {
                count: width < 360 ? 3 : 5,
                format: (day: number) => tick.format(new Date(`${dateOf(day)}T00:00:00Z`)),
              },
              tickLabels: { thin: true },
            },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: { strokeOpacity: 0.12 },
            axis: { line: false, ticks: { count: 4, format: compact } },
          },
        },
      }),
      focus: "nearest-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        content: (points: readonly ChartPoint<BalancePoint>[]) => {
          // A projection starts on today's actual point; show the post-payment one.
          const point = points.findLast((entry) => projected.includes(entry.datum)) ?? points[0];
          const row = point?.datum;
          if (!row) return { title: "", rows: [] };
          const expected = projected.includes(row) && row !== projected[0];
          return {
            title: formatDay(row.date),
            rows: [
              ...row.scheduled.map((payment) => ({
                label: payment.name,
                value: money.formatCents(payment.amount),
              })),
              {
                label: expected ? "Expected available" : "Available",
                value: money.formatCents(row.value),
                color,
              },
            ],
          };
        },
      },
    });
  });
  return (
    <Show
      when={props.series.actual.length || props.series.projected.length}
      fallback={<p class="chart-empty">No data for this period</p>}
    >
      <Chart
        class="money-chart"
        definition={definition()}
        ariaLabel={props.label}
        height={props.height ?? 180}
        initialWidth={400}
      />
    </Show>
  );
}
