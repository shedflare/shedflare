import { createMemo, For, Show } from "solid-js";
import { defineChart, type ChartPoint } from "@tanstack/charts";
import { pie, polar, radialArc, type PieDatum } from "@tanstack/charts/polar";
import { Chart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import { useCurrency } from "../lib/currency";
import { CATEGORY_SLOTS, categoryColor, type PieSlice } from "./types";

export interface DonutChartProps {
  /** Slices; negative values are treated as their absolute amount */
  slices: readonly PieSlice[];
  /** Accessible chart name */
  label: string;
  /** Donut diameter in px. Default 240 */
  size?: number;
}

interface DonutRow {
  label: string;
  value: number;
  color: string;
  share: number;
}

/** Keeps the largest slices and folds the tail into "Other" so hues never cycle. */
export function foldSlices(slices: readonly PieSlice[]): DonutRow[] {
  const positive = slices
    .map((slice) => ({ ...slice, value: Math.abs(slice.value) }))
    .filter((slice) => slice.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = positive.reduce((sum, slice) => sum + slice.value, 0);
  const kept = positive.length > CATEGORY_SLOTS ? positive.slice(0, CATEGORY_SLOTS - 1) : positive;
  const rest = positive.slice(kept.length);
  const rows = kept.map((slice, index) => ({
    label: slice.label,
    value: slice.value,
    color: slice.color ?? categoryColor(index),
  }));
  if (rest.length) {
    rows.push({
      label: "Other",
      value: rest.reduce((sum, slice) => sum + slice.value, 0),
      color: "var(--chart-other)",
    });
  }
  return rows.map((row) => ({ ...row, share: total ? row.value / total : 0 }));
}

/** Part-to-whole breakdown with a value legend beside the ring. */
export default function DonutChart(props: DonutChartProps) {
  const fmt = useCurrency();
  const rows = createMemo(() => foldSlices(props.slices));
  const percent = createMemo(
    () => new Intl.NumberFormat(fmt().locale, { style: "percent", maximumFractionDigits: 0 }),
  );
  const definition = createMemo(() => {
    const data = rows();
    const money = fmt();
    const share = percent();
    return defineChart({
      marks: [
        polar({
          inset: 4,
          marks: [
            radialArc(pie(data, { value: "value", gapAngle: 0.02 }), {
              innerRadius: ({ radius }) => radius * 0.6,
              cornerRadius: 4,
              color: "label",
              key: "label",
            }),
          ],
          scales: { angle: null, radius: null },
        }),
      ],
      scales: { x: null, y: null },
      color: { domain: data.map((row) => row.label), range: data.map((row) => row.color) },
      tooltip: {
        use: tooltip,
        content: (points: readonly ChartPoint<PieDatum<DonutRow>>[]) => {
          const row = points[0]?.datum;
          return {
            title: row?.label ?? "",
            rows: row
              ? [
                  {
                    label: share.format(row.share),
                    value: money.formatCents(row.value),
                    color: row.color,
                  },
                ]
              : [],
          };
        },
      },
    });
  });
  return (
    <Show when={rows().length} fallback={<p class="chart-empty">No data for this period</p>}>
      <div class="money-donut">
        <Chart
          class="money-chart money-donut-ring"
          definition={definition()}
          ariaLabel={props.label}
          height={props.size ?? 240}
          initialWidth={props.size ?? 240}
        />
        <ul class="money-chart-legend" aria-label={`${props.label} legend`}>
          <For each={rows()}>
            {(row) => (
              <li>
                <span class="money-chart-swatch" style={{ background: row.color }} />
                <span class="money-chart-legend-label">{row.label}</span>
                <span class="money-chart-legend-value">{fmt().formatCents(row.value)}</span>
                <span class="money-chart-legend-share">{percent().format(row.share)}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
