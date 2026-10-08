import {
  createMemo,
  createResource,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { currentMonthKey, shiftMonth, categoryTone } from "../lib/budget-view";
import { validReportMonth } from "../domain/monthly-report";
import { listenForMoneyDataChanged } from "../lib/data-events";
import { AreaChart, BarChart, CHART_COLORS, type BarGroup } from "../charts";
import CategoryBadge from "../components/CategoryBadge";
import MoneyIcon from "../components/MoneyIcon";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
const AdvancedReports = lazy(() => import("../components/AdvancedReports"));

function Change(props: { current: number; previous: number; expense?: boolean }) {
  const privacy = usePrivacyMode();
  const change = () =>
    props.previous > 0
      ? Math.round(((props.current - props.previous) / props.previous) * 100)
      : null;
  return (
    <Show when={change() !== null && change() !== 0}>
      <span
        class={`report-change ${privacy().blurClass()}`}
        classList={{
          "is-improvement": props.expense ? (change() ?? 0) < 0 : (change() ?? 0) > 0,
          "is-increase": props.expense ? (change() ?? 0) > 0 : (change() ?? 0) < 0,
        }}
        aria-label={`${change()} percent change from previous month`}
      >
        {(change() ?? 0) > 0 ? "+" : ""}
        {change()}%
      </span>
    </Show>
  );
}
export default function ReportsPage() {
  const [params, setParams] = useSearchParams<{ month?: string; view?: string }>();
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const shell = useMoneyShell();
  const view = () =>
    params.view === "net-worth" || params.view === "cash-flow" || params.view === "advanced"
      ? params.view
      : "monthly";
  // Year-spanning axes mark January with its year so repeated month names stay unambiguous.
  const shortMonth = (key: string) => {
    const name = df().formatMonth(key).split(" ")[0].slice(0, 3);
    return key.slice(5, 7) === "01" ? `${name} ’${key.slice(2, 4)}` : name;
  };
  const fullMonth = (key: string) => df().formatMonth(key);
  const month = () =>
    params.month && validReportMonth(params.month) ? params.month : currentMonthKey();
  const [monthlyResult, { refetch: refetchMonthly }] = createResource(
    () => (view() === "monthly" ? month() : false),
    (key) => loadRequest(() => api.reports.monthly(key)),
  );
  const report = () => {
    const result = requestValue(monthlyResult());
    return result?.month === month() ? result : undefined;
  };
  const [worthResult, { refetch: refetchWorth }] = createResource(
    () => view() === "net-worth",
    () =>
      loadRequest(async () => {
        const [history, accounts] = await Promise.all([api.reports.netWorth(), api.accounts()]);
        return {
          points: [...history.points],
          accounts: accounts.accounts.filter((row) => !row.closed),
        };
      }),
  );
  const worth = () => requestValue(worthResult());
  const balance = createMemo(() =>
    (worth()?.accounts ?? []).reduce((sum, row) => sum + row.balanceCurrent, 0),
  );
  const [flowResult, { refetch: refetchFlow }] = createResource(
    () => view() === "cash-flow",
    () => loadRequest(() => api.reports.cashFlow()),
  );
  const flow = () => requestValue(flowResult());
  const flowTotals = createMemo(() =>
    (flow()?.months ?? []).reduce(
      (sum, row) => ({ income: sum.income + row.income, expense: sum.expense + row.expense }),
      { income: 0, expense: 0 },
    ),
  );
  const flowGroups = createMemo((): BarGroup[] =>
    (flow()?.months ?? []).map((row) => ({
      category: row.month,
      values: [
        { label: "Income", value: row.income, color: CHART_COLORS.income },
        { label: "Spending", value: row.expense, color: CHART_COLORS.spending },
      ],
    })),
  );
  const maximum = createMemo(() =>
    Math.max(1, ...(report()?.categories ?? []).map((row) => row.amount)),
  );
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        if (view() === "monthly") void refetchMonthly();
        if (view() === "net-worth") void refetchWorth();
        if (view() === "cash-flow") void refetchFlow();
      }),
    ),
  );
  function selectView(next: string) {
    setParams({ view: next === "monthly" ? undefined : next });
  }
  return (
    <div class="page monthly-reports-page">
      <div class="page-header">
        <h1 class="page-title">Reports</h1>
        <details class="entity-menu">
          <summary aria-label="Report actions">
            <MoneyIcon name="more" />
          </summary>
          <div class="entity-menu-popover">
            <button
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                selectView(view() === "advanced" ? "monthly" : "advanced");
              }}
            >
              {view() === "advanced" ? "Monthly view" : "Advanced reports"}
            </button>
          </div>
        </details>
      </div>
      <Show
        when={view() !== "advanced"}
        fallback={
          <Suspense fallback={<p class="quiet-empty">Loading…</p>}>
            <AdvancedReports />
          </Suspense>
        }
      >
        <div class="report-navigation">
          <div class="filter-chips" aria-label="Report views">
            <button
              classList={{ active: view() === "monthly" }}
              onClick={() => selectView("monthly")}
            >
              Monthly
            </button>
            <button
              classList={{ active: view() === "net-worth" }}
              onClick={() => selectView("net-worth")}
            >
              Net worth
            </button>
            <button
              classList={{ active: view() === "cash-flow" }}
              onClick={() => selectView("cash-flow")}
            >
              Cash flow
            </button>
          </div>
          <Show when={view() === "monthly"}>
            <div class="month-picker">
              <button
                class="btn btn-icon btn-ghost"
                aria-label="Previous month"
                onClick={() => setParams({ month: shiftMonth(month(), -1) })}
              >
                ‹
              </button>
              <label class="month-picker-current">
                <span>{df().formatMonth(month())}</span>
                <input
                  type="month"
                  aria-label="Report month"
                  min="1000-01"
                  value={month()}
                  onInput={(event) => {
                    if (validReportMonth(event.currentTarget.value))
                      setParams({ month: event.currentTarget.value });
                  }}
                />
              </label>
              <button
                class="btn btn-icon btn-ghost"
                aria-label="Next month"
                onClick={() => setParams({ month: shiftMonth(month(), 1) })}
              >
                ›
              </button>
            </div>
          </Show>
        </div>
        <Show when={view() === "monthly"}>
          <PageState
            loading={monthlyResult.loading && !report()}
            error={requestError(monthlyResult())}
            onRetry={() => void refetchMonthly()}
          >
            <Show
              when={report()?.transactionCount}
              fallback={
                <div class="money-empty">
                  <span class="money-empty-icon">
                    <MoneyIcon name="chart" size={32} />
                  </span>
                  <h2>No activity in {df().formatMonth(month()).split(" ")[0]}</h2>
                  <Show
                    when={report()?.hasAccounts}
                    fallback={
                      <A class="btn btn-primary" href="/accounts?new=1">
                        Add account
                      </A>
                    }
                  >
                    <button class="btn btn-primary" onClick={() => shell.openTransaction()}>
                      Add transaction
                    </button>
                  </Show>
                </div>
              }
            >
              <div class="report-metrics">
                <div class="report-metric">
                  <span>Income</span>
                  <strong class={privacy().blurClass()}>
                    {fmt().formatCents(report()?.income ?? 0)}
                  </strong>
                  <Show when={report()?.previous.transactionCount}>
                    <Change current={report()!.income} previous={report()!.previous.income} />
                  </Show>
                </div>
                <div class="report-metric">
                  <span>Expenses</span>
                  <strong class={privacy().blurClass()}>
                    {fmt().formatCents(report()?.expense ?? 0)}
                  </strong>
                  <Show when={report()?.previous.transactionCount}>
                    <Change
                      current={report()!.expense}
                      previous={report()!.previous.expense}
                      expense
                    />
                  </Show>
                </div>
              </div>
              <div class="report-spending-heading">
                <h2>Spending</h2>
                <Show when={report()?.previous.transactionCount}>
                  <span>vs {df().formatMonth(report()!.previous.month).split(" ")[0]}</span>
                </Show>
              </div>
              <div class="report-spending-list">
                <For each={report()?.categories}>
                  {(row) => (
                    <A
                      class="report-spending-row"
                      href={
                        row.categoryId
                          ? `/?month=${month()}&category=${encodeURIComponent(row.categoryId)}`
                          : `/?month=${month()}&view=uncategorized`
                      }
                      aria-label={`${row.name}, ${fmt().formatCents(row.amount)}, open activity`}
                    >
                      <CategoryBadge name={row.name} icon={row.icon} />
                      <div class="report-spending-name">
                        <strong>{row.name}</strong>
                        <span
                          class={`report-category-track tone-${categoryTone(row.name)} ${privacy().blurClass()}`}
                        >
                          <span
                            style={{ width: `${(Math.max(0, row.amount) / maximum()) * 100}%` }}
                          />
                        </span>
                      </div>
                      <div class="report-spending-amount">
                        <strong class={privacy().blurClass()}>
                          {fmt().formatCents(row.amount)}
                        </strong>
                        <Show when={report()?.previous.transactionCount}>
                          <Change current={row.amount} previous={row.previousAmount} expense />
                        </Show>
                      </div>
                      <MoneyIcon name="chevron" size={15} />
                    </A>
                  )}
                </For>
              </div>
              <Show when={!report()?.categories.length}>
                <p class="quiet-empty">No spending this month</p>
              </Show>
            </Show>
          </PageState>
        </Show>
        <Show when={view() === "net-worth"}>
          <PageState
            loading={worthResult.loading && !worth()}
            error={requestError(worthResult())}
            onRetry={() => void refetchWorth()}
          >
            <Show
              when={worth()?.accounts.length}
              fallback={
                <div class="money-empty">
                  <span class="money-empty-icon">
                    <MoneyIcon name="accounts" size={32} />
                  </span>
                  <h2>No accounts yet</h2>
                  <A class="btn btn-primary" href="/accounts?new=1">
                    Add account
                  </A>
                </div>
              }
            >
              <div class="worth-summary">
                <span>Net worth</span>
                <strong class={privacy().blurClass()}>{fmt().formatCents(balance())}</strong>
              </div>
              <div class={`worth-chart ${privacy().blurClass()}`}>
                <AreaChart
                  data={worth()?.points ?? []}
                  label="Net worth"
                  formatX={shortMonth}
                  formatTitle={fullMonth}
                />
              </div>
              <div class="worth-account-list">
                <For each={worth()?.accounts}>
                  {(account) => (
                    <A href={`/accounts/${account.id}`}>
                      <span>{account.name}</span>
                      <strong class={privacy().blurClass()}>
                        {fmt().formatCents(account.balanceCurrent)}
                      </strong>
                      <MoneyIcon name="chevron" size={15} />
                    </A>
                  )}
                </For>
              </div>
            </Show>
          </PageState>
        </Show>
        <Show when={view() === "cash-flow"}>
          <PageState
            loading={flowResult.loading && !flow()}
            error={requestError(flowResult())}
            onRetry={() => void refetchFlow()}
          >
            <Show
              when={flowTotals().income || flowTotals().expense}
              fallback={
                <div class="money-empty">
                  <span class="money-empty-icon">
                    <MoneyIcon name="chart" size={32} />
                  </span>
                  <h2>No activity in the last year</h2>
                  <button class="btn btn-primary" onClick={() => shell.openTransaction()}>
                    Add transaction
                  </button>
                </div>
              }
            >
              <div class="report-metrics">
                <div class="report-metric">
                  <span>Income, last 13 months</span>
                  <strong class={privacy().blurClass()}>
                    {fmt().formatCents(flowTotals().income)}
                  </strong>
                </div>
                <div class="report-metric">
                  <span>Spending, last 13 months</span>
                  <strong class={privacy().blurClass()}>
                    {fmt().formatCents(flowTotals().expense)}
                  </strong>
                </div>
              </div>
              <div class={`worth-chart ${privacy().blurClass()}`}>
                <BarChart
                  groups={flowGroups()}
                  label="Income and spending by month"
                  formatX={shortMonth}
                  formatTitle={fullMonth}
                />
              </div>
            </Show>
          </PageState>
        </Show>
      </Show>
    </div>
  );
}
