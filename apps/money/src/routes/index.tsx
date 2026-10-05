import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { availableRatio, currentMonthKey, expenseCategories, shiftMonth } from "../lib/budget-view";
import { canRecordPayment, runPaymentAction } from "../lib/recurring-actions";
import { orderedPayments, paymentDate } from "../lib/recurring-view";
import { formatCalendarDate, toMonthInt } from "../domain/types";
import { listenForMoneyDataChanged } from "../lib/data-events";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
import ActivityPanel, { type ActivityParams } from "../components/ActivityPanel";
import MoneyIcon from "../components/MoneyIcon";
import CategoryDrawer from "../components/CategoryDrawer";
import CategoryBadge from "../components/CategoryBadge";
import MoneySetup from "../components/MoneySetup";
import { readSetupState } from "../domain/setup";
import type { SchedulesResponse } from "../domain/schemas-client";

type Payment = SchedulesResponse["schedules"][number];

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** What happened: the month's numbers, every transaction, and the context needed to act on them. */
export default function Overview() {
  const shell = useMoneyShell();
  const navigate = useNavigate();
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [params, setParams] = useSearchParams<ActivityParams>();
  const [showSetup, setShowSetup] = createSignal(false);
  const [drawer, setDrawer] = createSignal<string | null>(null);
  const [paying, setPaying] = createSignal<string | null>(null);
  const [payError, setPayError] = createSignal<string | null>(null);
  const allTime = () => params.month === "all";
  const month = createMemo(() =>
    MONTH_PATTERN.test(params.month ?? "") ? params.month! : currentMonthKey(),
  );
  const today = formatCalendarDate(new Date());

  const [dataResult, { refetch }] = createResource(month, (key) =>
    loadRequest(async () => {
      const [budget, definitions, accounts, settings] = await Promise.all([
        api.budgetMonth(toMonthInt(key)),
        api.categories(),
        api.accounts(),
        api.settings(),
      ]);
      return {
        month: key,
        budget,
        definitions: definitions.categories,
        accounts: accounts.accounts,
        settings: settings.settings,
      };
    }),
  );
  const data = () => {
    const value = requestValue(dataResult());
    return value?.month === month() ? value : undefined;
  };
  const [reportResult, { refetch: refetchReport }] = createResource(month, (key) =>
    loadRequest(() => api.reports.monthly(key)),
  );
  const report = () => {
    const value = requestValue(reportResult());
    return value?.month === month() ? value : undefined;
  };
  const [schedulesResult, { refetch: refetchSchedules }] = createResource(() =>
    loadRequest(() => api.schedules()),
  );
  const schedules = () => requestValue(schedulesResult())?.schedules ?? [];
  const [uncategorized, setUncategorized] = createSignal(0);
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        void refetch();
        void refetchReport();
        void refetchSchedules();
      }),
    ),
  );

  const categories = createMemo(() =>
    expenseCategories(data()?.budget.categories ?? [], data()?.definitions ?? []),
  );
  const definitionFor = (id: string) => data()?.definitions.find((row) => row.id === id);
  const activeAccounts = createMemo(() =>
    (data()?.accounts ?? []).filter((account) => !account.closed),
  );
  const netWorth = createMemo(() =>
    activeAccounts().reduce((sum, account) => sum + account.balanceCurrent, 0),
  );
  const available = createMemo(() =>
    categories().reduce((total, category) => total + category.leftover, 0),
  );
  const overspent = createMemo(() => categories().filter((category) => category.leftover < 0));
  const comingUp = createMemo(() => {
    const horizon = formatCalendarDate(new Date(Date.now() + 14 * 86_400_000));
    return orderedPayments(
      schedules().filter(
        (payment) =>
          payment.active && !payment.completed && (paymentDate(payment) ?? "9999") <= horizon,
      ),
    );
  });
  const overdue = createMemo(() =>
    comingUp().filter((payment) => (paymentDate(payment) ?? today) < today),
  );
  const focusedCategory = createMemo(() =>
    categories().find((category) => category.categoryId === params.category),
  );
  const drawerCategory = createMemo(() =>
    categories().find((category) => category.categoryId === drawer()),
  );
  const setupState = () =>
    readSetupState(data()?.settings.find((row) => row.key === "money_setup")?.value)?.state;
  const canSetup = () =>
    !!data() &&
    data()!.accounts.length === 0 &&
    data()!.definitions.length === 0 &&
    setupState() !== "complete";

  function toggle(key: "account" | "category", id: string) {
    const next = params[key] === id ? undefined : id;
    setParams(
      key === "account"
        ? { account: next, focus: undefined }
        : { category: next, focus: undefined },
      { replace: true },
    );
  }
  async function record(payment: Payment) {
    if (paying()) return;
    if (!canRecordPayment(payment, data()?.accounts ?? [])) {
      navigate(`/plan?payment=${encodeURIComponent(payment.id)}`);
      return;
    }
    setPaying(payment.id);
    setPayError(null);
    try {
      await runPaymentAction(payment, "record");
    } catch (caught) {
      setPayError(caught instanceof Error ? caught.message : "Could not record payment");
    } finally {
      setPaying(null);
    }
  }
  function money(cents: number) {
    return fmt().formatCents(cents);
  }

  return (
    <div class="page ws-page overview-page">
      <div class="ws-header">
        <div class="ws-title">
          <h1 class="page-title">Overview</h1>
          <div class="month-nav ws-month">
            <button
              class="btn btn-icon btn-ghost"
              aria-label="Previous month"
              onClick={() => setParams({ month: shiftMonth(month(), -1), focus: undefined })}
            >
              ‹
            </button>
            <h2>{allTime() ? "All time" : df().formatMonth(month())}</h2>
            <button
              class="btn btn-icon btn-ghost"
              aria-label="Next month"
              onClick={() => setParams({ month: shiftMonth(month(), 1), focus: undefined })}
            >
              ›
            </button>
            <Show when={params.month}>
              <button class="text-button" onClick={() => setParams({ month: undefined })}>
                This month
              </button>
            </Show>
            <Show when={!allTime()}>
              <button class="text-button" onClick={() => setParams({ month: "all" })}>
                All time
              </button>
            </Show>
          </div>
        </div>
        <div class="page-actions">
          <A
            class="btn btn-secondary btn-sm"
            href={`/plan${params.month && !allTime() ? `?month=${month()}` : ""}`}
          >
            <MoneyIcon name="budget" size={15} />
            Plan
          </A>
          <button class="btn btn-primary btn-sm" onClick={() => shell.openTransaction()}>
            <MoneyIcon name="plus" size={15} />
            Add transaction
          </button>
        </div>
      </div>
      <PageState
        loading={dataResult.loading && !data()}
        error={requestError(dataResult()) ? "Your money couldn’t be loaded." : null}
        onRetry={() => {
          void refetch();
        }}
      >
        <Show
          when={activeAccounts().length > 0}
          fallback={
            <div class="money-empty home-start">
              <span class="money-empty-icon">
                <MoneyIcon name="accounts" size={36} />
              </span>
              <h2>{canSetup() ? "Make yourself at home" : "No open accounts"}</h2>
              <Show
                when={canSetup() && setupState() !== "skipped"}
                fallback={
                  <A class="btn btn-primary" href="/accounts?new=1">
                    <MoneyIcon name="plus" />
                    Add an account
                  </A>
                }
              >
                <button class="btn btn-primary" onClick={() => setShowSetup(true)}>
                  Set up Money
                  <MoneyIcon name="arrow" size={17} />
                </button>
              </Show>
              <Show when={canSetup() && setupState() === "skipped"}>
                <button class="text-button" onClick={() => setShowSetup(true)}>
                  Set up Money
                </button>
              </Show>
              <Show when={!canSetup()}>
                <A class="text-button" href="/accounts">
                  View accounts
                </A>
              </Show>
            </div>
          }
        >
          <div class={`ws-stats ${privacy().blurClass()}`}>
            <div class="ws-stat">
              <span>
                Money in{allTime() ? ` · ${df().formatMonth(month()).split(" ")[0]}` : ""}
              </span>
              <strong class="money-in">{report() ? money(report()!.income) : "—"}</strong>
              <Show when={report()?.previous.transactionCount}>
                <small>last month {money(report()!.previous.income)}</small>
              </Show>
            </div>
            <div class="ws-stat">
              <span>Money out</span>
              <strong>{report() ? money(report()!.expense) : "—"}</strong>
              <Show when={report()?.previous.transactionCount}>
                <small>last month {money(report()!.previous.expense)}</small>
              </Show>
            </div>
            <div class="ws-stat">
              <span>Net</span>
              <strong
                classList={{
                  negative: !!report() && report()!.income - report()!.expense < 0,
                  "money-in": !!report() && report()!.income - report()!.expense > 0,
                }}
              >
                {report() ? money(report()!.income - report()!.expense) : "—"}
              </strong>
            </div>
            <A class="ws-stat" href={`/plan?month=${month()}`}>
              <span>Left in categories</span>
              <strong classList={{ negative: available() < 0 }}>{money(available())}</strong>
              <small>
                {(data()?.budget.toBudget ?? 0) < 0
                  ? `${money(-(data()?.budget.toBudget ?? 0))} overassigned`
                  : `${money(data()?.budget.toBudget ?? 0)} to assign`}
              </small>
            </A>
            <div class="ws-stat">
              <span>Net worth</span>
              <strong classList={{ negative: netWorth() < 0 }}>{money(netWorth())}</strong>
              <small>
                {activeAccounts().length} account{activeAccounts().length === 1 ? "" : "s"}
              </small>
            </div>
          </div>
          <Show
            when={
              overspent().length ||
              (data()?.budget.toBudget ?? 0) !== 0 ||
              uncategorized() > 0 ||
              overdue().length
            }
          >
            <div class="ws-alerts">
              <Show when={overspent().length}>
                <button
                  class="notice notice-danger"
                  onClick={() => toggle("category", overspent()[0].categoryId)}
                >
                  <span class="notice-dot" />
                  <strong>
                    {overspent().length === 1
                      ? `${overspent()[0].categoryName} overspent`
                      : `${overspent().length} overspent`}
                  </strong>
                  <span class={privacy().blurClass()}>
                    {money(-overspent().reduce((total, category) => total + category.leftover, 0))}
                  </span>
                </button>
              </Show>
              <Show when={(data()?.budget.toBudget ?? 0) !== 0}>
                <A
                  class="notice"
                  classList={{ "notice-danger": (data()?.budget.toBudget ?? 0) < 0 }}
                  href={`/plan?month=${month()}`}
                >
                  <span class="notice-dot" />
                  <strong>
                    {(data()?.budget.toBudget ?? 0) < 0 ? "Overassigned" : "To assign"}
                  </strong>
                  <span class={privacy().blurClass()}>
                    {money(Math.abs(data()?.budget.toBudget ?? 0))}
                  </span>
                  <MoneyIcon name="arrow" size={14} />
                </A>
              </Show>
              <Show when={uncategorized() > 0}>
                <button
                  class="notice notice-warning"
                  onClick={() =>
                    setParams({ view: "uncategorized", month: "all", category: undefined })
                  }
                >
                  <span class="notice-dot" />
                  <strong>{uncategorized()} to categorize</strong>
                </button>
              </Show>
              <Show when={overdue().length}>
                <A
                  class="notice notice-danger"
                  href={`/plan?payment=${encodeURIComponent(overdue()[0].id)}`}
                >
                  <span class="notice-dot" />
                  <strong>
                    {overdue().length} overdue payment{overdue().length === 1 ? "" : "s"}
                  </strong>
                  <MoneyIcon name="arrow" size={14} />
                </A>
              </Show>
            </div>
          </Show>
          <div class="ws-grid">
            <div class="ws-main">
              <Show when={focusedCategory()} keyed>
                {(category) => (
                  <div class={`category-context ${privacy().blurClass()}`}>
                    <CategoryBadge
                      name={category.categoryName}
                      icon={definitionFor(category.categoryId)?.icon}
                    />
                    <div class="category-context-name">
                      <strong>{category.categoryName}</strong>
                      <span class="pg-meter" aria-hidden="true">
                        <span
                          classList={{ "is-overspent": category.leftover < 0 }}
                          style={{
                            width: `${category.leftover < 0 ? 100 : availableRatio(category) * 100}%`,
                          }}
                        />
                      </span>
                    </div>
                    <span>
                      Assigned<strong>{money(category.budgeted)}</strong>
                    </span>
                    <span>
                      Spent<strong>{money(Math.max(0, -category.spent))}</strong>
                    </span>
                    <span>
                      Available
                      <strong classList={{ negative: category.leftover < 0 }}>
                        {money(category.leftover)}
                      </strong>
                    </span>
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      onClick={() => setDrawer(category.categoryId)}
                    >
                      {category.leftover < 0 ? "Cover" : "Details"}
                    </button>
                  </div>
                )}
              </Show>
              <ActivityPanel
                month={allTime() ? null : month()}
                onLoaded={(rows) =>
                  setUncategorized(
                    rows.filter(
                      (row) =>
                        !row.isChild &&
                        !row.isParent &&
                        !row.transferId &&
                        !row.startingBalanceFlag &&
                        row.categoryId === null,
                    ).length,
                  )
                }
              />
            </div>
            <aside class="ws-rail">
              <section class="ws-panel">
                <div class="ws-panel-heading">
                  <h2>Accounts</h2>
                  <A class="text-button" href="/accounts">
                    Manage <MoneyIcon name="arrow" size={14} />
                  </A>
                </div>
                <div class="rail-list">
                  <For each={activeAccounts()}>
                    {(account) => (
                      <div class="rail-row" classList={{ active: params.account === account.id }}>
                        <button
                          type="button"
                          class="rail-row-main"
                          aria-pressed={params.account === account.id}
                          onClick={() => toggle("account", account.id)}
                        >
                          <span class="rail-row-name">
                            <strong>{account.name}</strong>
                            <small>{account.offbudget ? "Tracking" : "Budget"}</small>
                          </span>
                          <strong
                            class={`rail-row-amount ${privacy().blurClass()}`}
                            classList={{ negative: account.balanceCurrent < 0 }}
                          >
                            {money(account.balanceCurrent)}
                          </strong>
                        </button>
                        <A
                          class="rail-row-link"
                          href={`/accounts/${account.id}`}
                          aria-label={`Open ${account.name}`}
                          title="Open account (reconcile, import)"
                        >
                          <MoneyIcon name="arrow" size={13} />
                        </A>
                      </div>
                    )}
                  </For>
                </div>
              </section>
              <section class="ws-panel">
                <div class="ws-panel-heading">
                  <h2>Coming up</h2>
                  <A class="text-button" href="/plan">
                    Recurring <MoneyIcon name="arrow" size={14} />
                  </A>
                </div>
                <Show
                  when={!schedulesResult.loading || requestValue(schedulesResult())}
                  fallback={
                    <p class="ws-empty" role="status">
                      Loading…
                    </p>
                  }
                >
                  <Show
                    when={!requestError(schedulesResult())}
                    fallback={
                      <button class="btn btn-secondary btn-sm" onClick={() => refetchSchedules()}>
                        Retry upcoming
                      </button>
                    }
                  >
                    <Show when={payError()}>
                      <p class="form-error" role="alert">
                        {payError()}
                      </p>
                    </Show>
                    <Show
                      when={comingUp().length}
                      fallback={<p class="ws-empty">Nothing due in the next two weeks</p>}
                    >
                      <div class="rec-list">
                        <For each={comingUp()}>
                          {(payment) => {
                            const due = () => paymentDate(payment)!;
                            return (
                              <div class="rec-row" classList={{ "is-overdue": due() < today }}>
                                <A
                                  class="rec-row-main"
                                  href={`/plan?payment=${encodeURIComponent(payment.id)}`}
                                >
                                  <span class="rec-date">
                                    <small>
                                      {new Intl.DateTimeFormat(undefined, {
                                        month: "short",
                                      }).format(new Date(`${due()}T12:00:00`))}
                                    </small>
                                    <strong>{Number(due().slice(8, 10))}</strong>
                                  </span>
                                  <span class="rec-name">
                                    <strong>{payment.name ?? "Scheduled payment"}</strong>
                                    <small>
                                      {due() < today
                                        ? "Overdue"
                                        : due() === today
                                          ? "Today"
                                          : df().formatDate(due())}
                                    </small>
                                  </span>
                                  <span
                                    class={`rec-amount ${privacy().blurClass()}`}
                                    classList={{ "money-in": (payment.amount ?? 0) > 0 }}
                                  >
                                    {payment.amount === null ? "Variable" : money(payment.amount)}
                                  </span>
                                </A>
                                <span class="rec-actions">
                                  <button
                                    type="button"
                                    class="btn btn-icon btn-ghost btn-sm"
                                    title="Record payment now"
                                    aria-label={`Record ${payment.name ?? "payment"}`}
                                    disabled={!!paying()}
                                    onClick={() => void record(payment)}
                                  >
                                    <Show
                                      when={paying() === payment.id}
                                      fallback={<MoneyIcon name="check" size={15} />}
                                    >
                                      …
                                    </Show>
                                  </button>
                                </span>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </section>
              <section class="ws-panel">
                <div class="ws-panel-heading">
                  <h2>Spending by category</h2>
                  <A class="text-button" href={`/plan?month=${month()}`}>
                    Plan <MoneyIcon name="arrow" size={14} />
                  </A>
                </div>
                <Show
                  when={categories().length}
                  fallback={
                    <p class="ws-empty">
                      No categories yet. <A href="/plan?new=1">Add one</A>
                    </p>
                  }
                >
                  <div class="rail-list rail-categories">
                    <For each={categories()}>
                      {(category) => (
                        <button
                          type="button"
                          class="rail-category"
                          classList={{
                            active: params.category === category.categoryId,
                            "is-overspent": category.leftover < 0,
                          }}
                          aria-pressed={params.category === category.categoryId}
                          onClick={() => toggle("category", category.categoryId)}
                        >
                          <CategoryBadge
                            name={category.categoryName}
                            icon={definitionFor(category.categoryId)?.icon}
                            small
                          />
                          <span class="rail-category-body">
                            <span class="rail-category-line">
                              <strong>{category.categoryName}</strong>
                              <strong
                                class={privacy().blurClass()}
                                classList={{ negative: category.leftover < 0 }}
                              >
                                {money(category.leftover)}
                              </strong>
                            </span>
                            <span class="pg-meter" aria-hidden="true">
                              <span
                                classList={{ "is-overspent": category.leftover < 0 }}
                                style={{
                                  width: `${category.leftover < 0 ? 100 : availableRatio(category) * 100}%`,
                                }}
                              />
                            </span>
                            <small class={privacy().blurClass()}>
                              {money(Math.max(0, -category.spent))} spent of{" "}
                              {money(category.leftover - category.spent)}
                            </small>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            </aside>
          </div>
        </Show>
      </PageState>
      <Show when={showSetup()}>
        <MoneySetup
          initialCurrency={
            data()?.settings.find((row) => row.key === "display_currency")?.value === "IDR"
              ? "IDR"
              : "USD"
          }
          onClose={() => {
            setShowSetup(false);
            void refetch();
          }}
        />
      </Show>
      <Show when={drawerCategory()} keyed>
        {(category) => (
          <CategoryDrawer
            month={month()}
            category={category}
            definition={definitionFor(category.categoryId)}
            categories={categories()}
            onClose={() => setDrawer(null)}
          />
        )}
      </Show>
    </div>
  );
}
