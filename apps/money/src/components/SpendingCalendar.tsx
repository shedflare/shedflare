import { createMemo, For, Show, type JSX } from "solid-js";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { compactCentsFormatter } from "../charts";
import MoneyIcon from "./MoneyIcon";
import { formatCalendarDate, parseCalendarDate } from "../domain/types";
import {
  type CalendarCell,
  type CalendarEntry,
  type CalendarDayTotals,
  calendarWeeks,
  spendingLevel,
  weekdayLabels,
  weekStartForLocale,
} from "../lib/report-calendar";

export type CalendarDay = Extract<CalendarCell, { kind: "day" }>;

export function useCalendarDayLabel() {
  const fmt = useCurrency();
  return (date: string, weekday: "long" | "short" = "long") => {
    const parsed = parseCalendarDate(date);
    return parsed
      ? new Intl.DateTimeFormat(fmt().locale, { weekday, day: "numeric", month: "long" }).format(
          parsed,
        )
      : date;
  };
}

/** Month grid shaded by daily spending. The selected day's heading is shown above `detail`. */
export default function SpendingCalendar(props: {
  month: string;
  days: readonly CalendarDayTotals[];
  selectedDay: string | undefined;
  onSelectDay: (date: string | undefined) => void;
  /** Scheduled payments shown on a date, as a marker. */
  scheduledMark?: (date: string) => { count: number; overdue: boolean } | undefined;
  /** The day's scheduled payments and transactions: a few fill the cell, all show on hover. */
  entries?: (date: string) => readonly CalendarEntry[];
  detail: (day: CalendarDay) => JSX.Element;
}) {
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const dayLabel = useCalendarDayLabel();
  const today = formatCalendarDate(new Date());
  const weekStart = createMemo(() => weekStartForLocale(fmt().locale));
  const labels = createMemo(() => weekdayLabels(fmt().locale, weekStart()));
  const compact = createMemo(() => compactCentsFormatter(fmt().code, fmt().locale));
  const weeks = createMemo(() => calendarWeeks(props.month, props.days, weekStart()));
  const maximum = createMemo(() => Math.max(0, ...props.days.map((row) => row.expense)));
  const selected = createMemo(() =>
    weeks()
      .flat()
      .find((cell): cell is CalendarDay => cell.kind === "day" && cell.date === props.selectedDay),
  );
  return (
    <>
      <div class="report-calendar" role="grid" aria-label="Daily spending">
        <div class="report-calendar-row" role="row">
          <For each={labels()}>
            {(label) => (
              <span class="report-calendar-weekday" role="columnheader">
                {label}
              </span>
            )}
          </For>
        </div>
        <For each={weeks()}>
          {(week, row) => (
            <div class="report-calendar-row" role="row">
              <For each={week}>
                {(cell, column) => {
                  const entries = () =>
                    cell.kind === "day" ? (props.entries?.(cell.date) ?? []) : [];
                  const amount = (entry: CalendarEntry, format: (cents: number) => string) =>
                    entry.amount === null
                      ? "Variable"
                      : `${entry.amount > 0 ? "+" : ""}${format(Math.abs(entry.amount))}`;
                  const mark = () =>
                    cell.kind === "day" ? props.scheduledMark?.(cell.date) : undefined;
                  const scheduled = () => mark()?.count ?? 0;
                  return cell.kind === "blank" ? (
                    <span class="report-calendar-blank" role="gridcell" />
                  ) : (
                    <button
                      type="button"
                      role="gridcell"
                      class={`report-calendar-day level-${spendingLevel(cell.expense, maximum())}`}
                      classList={{
                        "is-today": cell.date === today,
                        "is-future": cell.date > today,
                        "is-selected": cell.date === props.selectedDay,
                      }}
                      aria-pressed={cell.date === props.selectedDay}
                      aria-label={`${dayLabel(cell.date)}: spent ${fmt().formatCents(cell.expense)}${cell.income ? `, income ${fmt().formatCents(cell.income)}` : ""}${scheduled() ? `, ${scheduled()} scheduled` : ""}`}
                      onClick={() =>
                        props.onSelectDay(cell.date === props.selectedDay ? undefined : cell.date)
                      }
                    >
                      <span class="report-calendar-date">
                        {cell.day}
                        <Show when={scheduled()}>
                          <span
                            class="report-calendar-due"
                            classList={{ "is-overdue": mark()?.overdue }}
                            title={`${scheduled()} scheduled`}
                          >
                            <MoneyIcon name="calendar" size={10} />
                            <Show when={scheduled() > 1}>{scheduled()}</Show>
                          </span>
                        </Show>
                      </span>
                      <Show when={cell.expense !== 0}>
                        <span class={`report-calendar-spent ${privacy().blurClass()}`}>
                          {compact()(cell.expense)}
                        </span>
                      </Show>
                      <Show when={cell.income > 0}>
                        <span class={`report-calendar-income ${privacy().blurClass()}`}>
                          +{compact()(cell.income)}
                        </span>
                      </Show>
                      <Show when={entries().length}>
                        <span class={`report-calendar-entries ${privacy().blurClass()}`}>
                          <For each={entries().slice(0, 3)}>
                            {(entry) => (
                              <span
                                class="report-calendar-entry"
                                classList={{
                                  "is-scheduled": entry.kind === "scheduled",
                                  "is-overdue": entry.overdue,
                                }}
                              >
                                <span>{entry.label}</span>
                                <span>{amount(entry, compact())}</span>
                              </span>
                            )}
                          </For>
                          <Show when={entries().length > 3}>
                            <span class="report-calendar-more">+{entries().length - 3} more</span>
                          </Show>
                        </span>
                        <span
                          class={`report-calendar-popover ${privacy().blurClass()}`}
                          classList={{
                            "opens-left": column() >= 4,
                            "opens-up": row() >= weeks().length - 2,
                          }}
                          aria-hidden="true"
                        >
                          <strong>{dayLabel(cell.date)}</strong>
                          <For each={entries()}>
                            {(entry) => (
                              <span
                                class="report-calendar-entry"
                                classList={{
                                  "is-scheduled": entry.kind === "scheduled",
                                  "is-overdue": entry.overdue,
                                }}
                              >
                                <span>
                                  {entry.label}
                                  <Show when={entry.kind === "scheduled"}>
                                    <small>{entry.overdue ? " · overdue" : " · scheduled"}</small>
                                  </Show>
                                </span>
                                <span>{amount(entry, (cents) => fmt().formatCents(cents))}</span>
                              </span>
                            )}
                          </For>
                          <small class="report-calendar-popover-hint">Click for details</small>
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="report-calendar-legend" aria-hidden="true">
        <span>Less</span>
        <For each={[0, 1, 2, 3, 4]}>
          {(level) => <i class={`report-calendar-swatch level-${level}`} />}
        </For>
        <span>More spending</span>
      </div>
      <Show when={selected()} keyed>
        {(cell) => (
          <section class="report-calendar-detail" aria-live="polite">
            <div class="report-spending-heading">
              <h2>{dayLabel(cell.date)}</h2>
              <span class={privacy().blurClass()}>
                Spent {fmt().formatCents(cell.expense)}
                <Show when={cell.income}> · Income {fmt().formatCents(cell.income)}</Show>
              </span>
            </div>
            {props.detail(cell)}
          </section>
        )}
      </Show>
    </>
  );
}
