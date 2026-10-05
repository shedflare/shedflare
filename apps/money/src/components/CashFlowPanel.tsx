import { createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestError, requestValue } from "../lib/request-state";
import { listenForMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import MoneyIcon from "./MoneyIcon";

/** Last six months of money in/out so the plan can be judged against real history. */
export default function CashFlowPanel(props: { month: string }) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [result, { refetch }] = createResource(() => loadRequest(() => api.reports.cashFlow()));
  onMount(() => onCleanup(listenForMoneyDataChanged(() => void refetch())));
  const months = createMemo(() => (requestValue(result())?.months ?? []).slice(-6));
  const maximum = createMemo(() =>
    Math.max(1, ...months().flatMap((row) => [row.income, row.expense])),
  );
  const completed = createMemo(() =>
    months().filter((row) => row.month < props.month && (row.income !== 0 || row.expense !== 0)),
  );
  const average = (key: "income" | "expense") =>
    completed().length
      ? Math.round(completed().reduce((sum, row) => sum + row[key], 0) / completed().length)
      : null;
  return (
    <section class="ws-panel">
      <div class="ws-panel-heading">
        <h2>Cash flow</h2>
        <A class="text-button" href="/reports">
          All reports <MoneyIcon name="arrow" size={14} />
        </A>
      </div>
      <Show
        when={!result.loading || months().length}
        fallback={
          <p class="ws-empty" role="status">
            Loading…
          </p>
        }
      >
        <Show
          when={!requestError(result())}
          fallback={
            <div class="ws-inline-error" role="alert">
              <span>Cash flow couldn’t be loaded.</span>
              <button class="btn btn-secondary btn-sm" onClick={() => void refetch()}>
                Retry
              </button>
            </div>
          }
        >
          <Show when={average("expense") !== null}>
            <div class={`flow-averages ${privacy().blurClass()}`}>
              <span>
                Avg in<strong class="money-in">{fmt().formatCents(average("income")!)}</strong>
              </span>
              <span>
                Avg out<strong>{fmt().formatCents(average("expense")!)}</strong>
              </span>
            </div>
          </Show>
          <div class="flow-list">
            <For each={months()}>
              {(row) => (
                <A
                  class="flow-row"
                  classList={{ "is-current": row.month === props.month }}
                  href={`/plan?month=${row.month}`}
                >
                  <span class="flow-month">{df().formatMonth(row.month).slice(0, 3)}</span>
                  <span class={`flow-bars ${privacy().blurClass()}`} aria-hidden="true">
                    <span
                      class="flow-bar flow-bar-in"
                      style={{ width: `${(row.income / maximum()) * 100}%` }}
                    />
                    <span
                      class="flow-bar flow-bar-out"
                      style={{ width: `${(row.expense / maximum()) * 100}%` }}
                    />
                  </span>
                  <span
                    class={`flow-net ${privacy().blurClass()}`}
                    classList={{ negative: row.income - row.expense < 0 }}
                  >
                    {row.income - row.expense > 0 ? "+" : ""}
                    {fmt().formatCents(row.income - row.expense)}
                  </span>
                </A>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}
