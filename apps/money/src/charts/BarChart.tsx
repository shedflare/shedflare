import { createMemo, Show } from "solid-js";
import {
  barY,
  colorLegend,
  colorLegendItems,
  defineChart,
  group,
  ruleY,
  type ChartPoint,
} from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { Chart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import { useCurrency } from "../lib/currency";
import { categoryColor, compactCentsFormatter, type BarGroup } from "./types";

export interface BarChartProps {
  /** Groups of bars — each group is one category on the x-axis */
  groups: readonly BarGroup[];
  /** Accessible chart name */
  label: string;
  /** Stack series within a group instead of placing them side by side */
  stacked?: boolean;
  /** Chart height in px. Default 300 */
  height?: number;
  /** Format x-axis categories and tooltip titles */
  formatX?: (category: string) => string;
  /** Format tooltip titles; defaults to formatX */
  formatTitle?: (category: string) => string;
}

interface BarRow {
  key: string;
  category: string;
  series: string;
  value: number;
}

/** Discrete periods or categories compared side by side. */
export default function BarChart(props: BarChartProps) {
  const fmt = useCurrency();
  const definition = createMemo(() => {
    const formatX = props.formatX ?? String;
    const formatTitle = props.formatTitle ?? formatX;
    const stacked = props.stacked ?? false;
    const money = fmt();
    const compact = compactCentsFormatter(money.code, money.locale);
    const series: string[] = [];
    const paints: string[] = [];
    const rows: BarRow[] = [];
    for (const entry of props.groups) {
      for (const value of entry.values) {
        if (!series.includes(value.label)) {
          series.push(value.label);
          paints.push(value.color ?? categoryColor(series.length - 1));
        }
        rows.push({
          key: `${entry.category}\u0000${value.label}`,
          category: entry.category,
          series: value.label,
          value: value.value,
        });
      }
    }
    const crossesZero = rows.some((row) => row.value < 0);
    return defineChart({
      chart: ({ width }) => ({
        marks: [
          barY(rows, {
            x: "category",
            y: "value",
            color: "series",
            key: "key",
            radius: { end: 4 },
            inset: stacked ? 0 : 1,
            maxThickness: 36,
            layout: stacked ? undefined : group({ padding: 0.12 }),
          }),
          ...(crossesZero ? [ruleY([0], { stroke: "currentColor", strokeOpacity: 0.4 })] : []),
        ],
        scales: {
          x: {
            scale: () => scaleBand<string>().padding(0.24),
            axis: { line: false, ticks: { format: formatX }, tickLabels: { thin: true } },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: { strokeOpacity: 0.12 },
            axis: { line: false, ticks: { count: width < 480 ? 3 : 5, format: compact } },
          },
        },
      }),
      color: {
        domain: series,
        range: paints,
        legend:
          series.length > 1 ? colorLegend({ placement: "bottom", items: legendItems }) : undefined,
      },
      focus: "group-x",
      tooltip: {
        use: tooltip,
        content: (points: readonly ChartPoint<BarRow>[]) => ({
          title: points[0] ? formatTitle(points[0].datum.category) : "",
          rows: points.map((point) => ({
            label: point.datum.series,
            value: money.formatCents(point.datum.value),
            color: point.color,
          })),
        }),
      },
    });
  });
  return (
    <Show when={props.groups.length} fallback={<p class="chart-empty">No data for this period</p>}>
      <Chart
        class="money-chart"
        definition={definition()}
        ariaLabel={props.label}
        height={props.height ?? 300}
        initialWidth={640}
      />
    </Show>
  );
}

const legendItems = colorLegendItems({
  justify: "start",
  gap: 18,
  label: { fontSize: 12 },
});
