import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import MoneyIcon from "./MoneyIcon";
import { api } from "../lib/api";
import { loadRequest, requestError, requestValue } from "../lib/request-state";
import { listenForMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { canRecordPayment, runPaymentAction } from "../lib/recurring-actions";
import { recordDate, scheduledByDay, type ScheduledOccurrence } from "../lib/recurring-view";
import { formatCalendarDate, monthBoundaries } from "../domain/types";

type AccountRow = { id: string; closed: boolean };

/** Scheduled payments for a calendar month, refreshed whenever Money data changes. */
export function useScheduledPayments(month: () => string | null) {
  // Loads once something is shown; month changes reuse the same schedule list.
  const [result, { refetch }] = createResource(
    () => month() !== null,
    () =>
      loadRequest(async () => {
        const [schedules, accounts] = await Promise.all([api.schedules(), api.accounts()]);
        return { schedules: schedules.schedules, accounts: accounts.accounts };
      }),
  );
  onMount(() => onCleanup(listenForMoneyDataChanged(() => void refetch())));
  const byDay = createMemo(() => {
    const key = month();
    const data = requestValue(result());
    if (!key || !data) return new Map<string, ScheduledOccurrence[]>();
    const { start, end } = monthBoundaries(key);
    return scheduledByDay(data.schedules, start, end, formatCalendarDate(new Date()));
  });
  return {
    byDay,
    /** Calendar marker for a date: how many are shown there and whether any is overdue. */
    mark: (date: string) => {
      const due = byDay().get(date);
      if (!due?.length) return undefined;
      const today = formatCalendarDate(new Date());
      return { count: due.length, overdue: due.some((row) => row.date < today) };
    },
    accounts: (): readonly AccountRow[] => requestValue(result())?.accounts ?? [],
    error: () => requestError(result()),
    retry: () => void refetch(),
  };
}

/** Payments due on one day, each recordable in one click when it is the next one due. */
export function ScheduledDayList(props: {
  items: readonly ScheduledOccurrence[];
  accounts: readonly AccountRow[];
}) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [paying, setPaying] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const today = formatCalendarDate(new Date());
  async function record(item: ScheduledOccurrence) {
    if (paying()) return;
    setPaying(item.payment.id);
    setError(null);
    try {
      await runPaymentAction(item.payment, "record", { date: recordDate(item.date, today) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record payment");
    } finally {
      setPaying(null);
    }
  }
  return (
    <Show when={props.items.length}>
      <div class="calendar-scheduled">
        <h3>Scheduled</h3>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <For each={props.items}>
          {(item) => {
            const name = () => item.payment.name ?? "Scheduled payment";
            const recordable = () => canRecordPayment(item.payment, props.accounts);
            return (
              <div class="calendar-scheduled-row" classList={{ "is-overdue": item.date < today }}>
                <A
                  class="calendar-scheduled-name"
                  href={`/plan?payment=${encodeURIComponent(item.payment.id)}`}
                >
                  <strong>{name()}</strong>
                  <small>
                    {!item.isNext
                      ? "After the earlier payment is recorded"
                      : item.date < today
                        ? "Overdue"
                        : item.date === today
                          ? "Due today"
                          : `Due ${df().formatDate(item.date)}`}
                  </small>
                </A>
                <span
                  class={`calendar-scheduled-amount ${privacy().blurClass()}`}
                  classList={{ "money-in": (item.payment.amount ?? 0) > 0 }}
                >
                  {item.payment.amount === null
                    ? "Variable"
                    : fmt().formatCents(item.payment.amount)}
                </span>
                <Show when={item.isNext}>
                  <Show
                    when={recordable()}
                    fallback={
                      <A
                        class="btn btn-secondary btn-sm"
                        href={`/plan?payment=${encodeURIComponent(item.payment.id)}`}
                      >
                        Add details
                      </A>
                    }
                  >
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      disabled={!!paying()}
                      title={
                        item.date > today
                          ? "Record now, dated today"
                          : `Record, dated ${df().formatDate(item.date)}`
                      }
                      aria-label={`Record ${name()}`}
                      onClick={() => void record(item)}
                    >
                      <MoneyIcon name="check" size={14} />
                      {paying() === item.payment.id ? "Recording…" : "Record"}
                    </button>
                  </Show>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
