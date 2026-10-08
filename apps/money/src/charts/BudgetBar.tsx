import { createMemo, Show } from "solid-js";
import {
  barX,
  colorLegend,
  colorLegendItems,
  defineChart,
  group,
  type ChartPoint,
} from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { Chart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import { useCurrency } from "../lib/currency";
import { CHART_COLORS, compactCentsFormatter, type BudgetPair } from "./types";

export interface BudgetBarProps {
  data: readonly BudgetPair[];
  /** Accessible chart name */
  label: string;
  /** Show the categories with the largest budget or spending first. Default 10 */
  maxCategories?: number;
}

const SERIES = ["Budgeted", "Spent"] as const;
type Series = (typeof SERIES)[number];

interface BudgetRow {
  key: string;
  category: string;
  series: Series;
  value: number;
  budgeted: number;
  actual: number;
}

const ROW_HEIGHT = 34;

/** Budgeted against spent per category, as paired horizontal bars. */
export default function BudgetBar(props: BudgetBarProps) {
  const fmt = useCurrency();
  const pairs = createMemo(() =>
    [...props.data]
      .sort((a, b) => Math.max(b.budgeted, b.actual) - Math.max(a.budgeted, a.actual))
      .slice(0, props.maxCategories ?? 10),
  );
  const definition = createMemo(() => {
    const money = fmt();
    const compact = compactCentsFormatter(money.code, money.locale);
    const rows: BudgetRow[] = pairs().flatMap((pair) =>
      SERIES.map((series) => ({
        key: `${pair.category}\u0000${series}`,
        category: pair.category,
        series,
        value: series === "Budgeted" ? pair.budgeted : pair.actual,
        budgeted: pair.budgeted,
        actual: pair.actual,
      })),
    );
    return defineChart({
      chart: ({ width }) => ({
        marks: [
          barX(rows, {
            x: "value",
            y: "category",
            color: "series",
            key: "key",
            radius: { end: 4 },
            inset: 1,
            layout: group({ padding: 0.08 }),
          }),
        ],
        scales: {
          x: {
            scale: scaleLinear,
            nice: true,
            grid: { strokeOpacity: 0.12 },
            axis: { line: false, ticks: { count: width < 480 ? 3 : 5, format: compact } },
          },
          y: {
            scale: () => scaleBand<string>().padding(0.28),
            axis: { line: false, ticks: { size: 0 } },
          },
        },
      }),
      color: {
        domain: [...SERIES],
        range: [CHART_COLORS.budget, CHART_COLORS.spending],
        legend: colorLegend({
          placement: "top",
          items: colorLegendItems({ justify: "start", gap: 18 }),
        }),
      },
      focus: "group-y",
      tooltip: {
        use: tooltip,
        content: (points: readonly ChartPoint<BudgetRow>[]) => {
          const row = points[0]?.datum;
          if (!row) return { title: "", rows: [] };
          const left = row.budgeted - row.actual;
          return {
            title: row.category,
            rows: [
              ...[...points]
                .sort((a, b) => SERIES.indexOf(a.datum.series) - SERIES.indexOf(b.datum.series))
                .map((point) => ({
                  label: point.datum.series,
                  value: money.formatCents(point.datum.value),
                  color: point.color,
                })),
              {
                label: left >= 0 ? "Left" : "Over",
                value: money.formatCents(Math.abs(left)),
              },
            ],
          };
        },
      },
    });
  });
  return (
    <Show when={pairs().length} fallback={<p class="chart-empty">No data for this period</p>}>
      <Chart
        class="money-chart"
        definition={definition()}
        ariaLabel={props.label}
        height={Math.max(160, pairs().length * ROW_HEIGHT + 72)}
        initialWidth={640}
      />
    </Show>
  );
}
