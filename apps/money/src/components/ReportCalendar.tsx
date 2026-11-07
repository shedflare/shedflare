import { createMemo, createResource, onCleanup, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import ActivityFeed from "./ActivityFeed";
import { PageState } from "./PageState";
import SpendingCalendar, { useCalendarDayLabel } from "./SpendingCalendar";
import { ScheduledDayList, useScheduledPayments } from "./ScheduledDay";
import { api } from "../lib/api";
import { loadRequest, requestError, requestValue } from "../lib/request-state";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { listenForMoneyDataChanged } from "../lib/data-events";
import { formatCalendarDate } from "../domain/types";
import type { MonthlyReport } from "../domain/monthly-report";
import { elapsedDays } from "../lib/report-calendar";

/** Reports calendar: month spending metrics, the day grid, and a selected day's activity. */
export default function ReportCalendar(props: {
  report: MonthlyReport;
  selectedDay: string | undefined;
  onSelectDay: (date: string | undefined) => void;
}) {
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const navigate = useNavigate();
  const today = formatCalendarDate(new Date());
  const busiest = createMemo(() =>
    props.report.days.reduce<MonthlyReport["days"][number] | undefined>(
      (top, row) => (row.expense > (top?.expense ?? 0) ? row : top),
      undefined,
    ),
  );
  const elapsed = createMemo(() => elapsedDays(props.report.month, today));
  const dayLabel = useCalendarDayLabel();
  const scheduled = useScheduledPayments(() => props.report.month);
  const [dayResult, { refetch }] = createResource(
    () => props.selectedDay ?? false,
    (day) =>
      loadRequest(async () => {
        const [list, categories] = await Promise.all([
          api.transactions({
            conditions: [
              { field: "date", op: "gte", value: day },
              { field: "date", op: "lte", value: day },
            ],
          }),
          api.categories(),
        ]);
        return { day, transactions: list.transactions, categories: categories.categories };
      }),
  );
  onMount(() => onCleanup(listenForMoneyDataChanged(() => void refetch())));
  const dayData = () => {
    const result = requestValue(dayResult());
    return result?.day === props.selectedDay ? result : undefined;
  };
  return (
    <>
      <div class="report-metrics">
        <div class="report-metric">
          <span>Average daily spending</span>
          <strong class={privacy().blurClass()}>
            {elapsed() ? fmt().formatCents(Math.round(props.report.expense / elapsed())) : "—"}
          </strong>
        </div>
        <div class="report-metric">
          <span>Days with spending</span>
          <strong>
            {props.report.days.filter((row) => row.expense > 0).length}
            <Show when={elapsed()}>
              <small> / {elapsed()}</small>
            </Show>
          </strong>
        </div>
        <Show when={busiest()}>
          {(row) => (
            <div class="report-metric">
              <span>Biggest day, {dayLabel(row().date, "short")}</span>
              <strong class={privacy().blurClass()}>{fmt().formatCents(row().expense)}</strong>
            </div>
          )}
        </Show>
      </div>
      <SpendingCalendar
        month={props.report.month}
        days={props.report.days}
        selectedDay={props.selectedDay}
        onSelectDay={props.onSelectDay}
        scheduledMark={scheduled.mark}
        detail={(day) => (
          <>
            <ScheduledDayList
              items={scheduled.byDay().get(day.date) ?? []}
              accounts={scheduled.accounts()}
            />
            <PageState
              loading={dayResult.loading && !dayData()}
              error={requestError(dayResult())}
              onRetry={() => void refetch()}
            >
              <Show
                when={dayData()?.transactions.length}
                fallback={
                  <Show when={!scheduled.byDay().get(day.date)?.length}>
                    <p class="quiet-empty">No transactions on this day</p>
                  </Show>
                }
              >
                <ActivityFeed
                  transactions={dayData()?.transactions ?? []}
                  categories={dayData()?.categories ?? []}
                  onSelect={(id) =>
                    navigate(`/?month=${props.report.month}&focus=${encodeURIComponent(id)}`)
                  }
                />
              </Show>
            </PageState>
          </>
        )}
      />
    </>
  );
}
