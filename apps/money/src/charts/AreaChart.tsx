import { createMemo, Show } from "solid-js";
import { areaY, defineChart, lineY, ruleY, type ChartPoint } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { Chart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import { useCurrency } from "../lib/currency";
import { CHART_COLORS, compactCentsFormatter, type TimeSeriesPoint } from "./types";

export interface AreaChartProps {
  data: readonly TimeSeriesPoint[];
  /** Accessible chart name; also the tooltip series label */
  label: string;
  /** CSS paint for the line and fill */
  color?: string;
  /** Chart height in px. Default 300 */
  height?: number;
  /** Format x values (dates or month keys) for ticks and tooltip titles */
  formatX?: (date: string) => string;
  /** Format tooltip titles; defaults to formatX */
  formatTitle?: (date: string) => string;
}

/** Ordered values over time, read with a snapped crosshair. */
export default function AreaChart(props: AreaChartProps) {
  const fmt = useCurrency();
  const definition = createMemo(() => {
    const rows = props.data;
    const label = props.label;
    const color = props.color ?? CHART_COLORS.balance;
    const formatX = props.formatX ?? String;
    const formatTitle = props.formatTitle ?? formatX;
    const money = fmt();
    const compact = compactCentsFormatter(money.code, money.locale);
    const crossesZero = rows.some((row) => row.value < 0);
    return defineChart({
      chart: ({ width }) => ({
        marks: [
          areaY(rows, { x: "date", y: "value", fill: color, fillOpacity: 0.12 }),
          ...(crossesZero ? [ruleY([0], { stroke: "currentColor", strokeOpacity: 0.4 })] : []),
          lineY(rows, { x: "date", y: "value", stroke: color, strokeWidth: 2 }),
          crosshair({ x: true, y: false }),
        ],
        scales: {
          x: {
            scale: () => scalePoint<string>().padding(0.1),
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
      focus: "nearest-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        content: (points: readonly ChartPoint<TimeSeriesPoint>[]) => {
          const row = points[0]?.datum;
          return {
            title: row ? formatTitle(row.date) : "",
            rows: row ? [{ label, value: money.formatCents(row.value), color }] : [],
          };
        },
      },
    });
  });
  return (
    <Show when={props.data.length} fallback={<p class="chart-empty">No data for this period</p>}>
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
