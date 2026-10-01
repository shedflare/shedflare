import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import {
  currentMonthKey,
  expenseCategories,
  availableRatio,
  categoryTone,
} from "../lib/budget-view";
import { formatCalendarDate, toMonthInt } from "../domain/types";
import { listenForMoneyDataChanged } from "../lib/data-events";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
import MoneyIcon from "../components/MoneyIcon";
import CategoryDrawer from "../components/CategoryDrawer";
import CategoryBadge from "../components/CategoryBadge";

export default function Dashboard() {
  const shell = useMoneyShell();
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const month = currentMonthKey();
  const [params, setParams] = useSearchParams<{ category?: string }>();
  const [group, setGroup] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [dataResult, { refetch }] = createResource(() =>
    loadRequest(async () => {
      const [budget, definitions, accounts] = await Promise.all([
        api.budgetMonth(toMonthInt(month)),
        api.categories(),
        api.accounts(),
      ]);
      return { budget, definitions: definitions.categories, accounts: accounts.accounts };
    }),
  );
  const data = () => requestValue(dataResult());
  const [activityResult, { refetch: refetchActivity }] = createResource(() =>
    loadRequest(() => api.transactions()),
  );
  const activity = () => requestValue(activityResult());
  const [schedulesResult, { refetch: refetchSchedules }] = createResource(() =>
    loadRequest(() => api.schedules()),
  );
  const schedules = () => requestValue(schedulesResult());
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        void refetch();
        void refetchActivity();
        void refetchSchedules();
      }),
    ),
  );
  const categories = createMemo(() =>
    expenseCategories(data()?.budget.categories ?? [], data()?.definitions ?? []),
  );
  const groups = createMemo(() => [
    ...new Set(categories().map((category) => category.groupName ?? "Other")),
  ]);
  const visible = createMemo(() =>
    categories().filter(
      (category) =>
        (!group() || (category.groupName ?? "Other") === group()) &&
        category.categoryName.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
    ),
  );
  const overspent = createMemo(() => categories().filter((category) => category.leftover < 0));
  const recent = createMemo(() =>
    (activity()?.transactions ?? []).filter((transaction) => !transaction.isChild).slice(0, 5),
  );
  const uncategorized = createMemo(
    () =>
      (activity()?.transactions ?? []).filter(
        (transaction) =>
          !transaction.isChild &&
          !transaction.isParent &&
          !transaction.transferId &&
          !transaction.startingBalanceFlag &&
          transaction.categoryId === null,
      ).length,
  );
  const upcoming = createMemo(() =>
    (schedules()?.schedules ?? [])
      .filter((schedule) => schedule.active && !schedule.completed && schedule.nextDate)
      .sort((left, right) => (left.nextDate ?? "").localeCompare(right.nextDate ?? ""))
      .slice(0, 4),
  );
  const selected = createMemo(() =>
    categories().find((category) => category.categoryId === params.category),
  );
  const available = createMemo(() =>
    categories().reduce((total, category) => total + category.leftover, 0),
  );
  const spent = createMemo(() =>
    categories().reduce((total, category) => total + Math.max(0, -category.spent), 0),
  );
  const activeAccounts = createMemo(() =>
    (data()?.accounts ?? []).filter((account) => !account.closed),
  );
  return (
    <div class="page daily-page">
      <div class="page-header">
        <div>
          <p class="date-label">
            {new Intl.DateTimeFormat(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            }).format(new Date())}
          </p>
          <h1 class="page-title">Home</h1>
        </div>
        <button class="btn btn-primary daily-add" onClick={() => shell.openTransaction()}>
          <MoneyIcon name="plus" />
          Add expense
        </button>
      </div>
      <PageState
        loading={dataResult.loading && !data()}
        error={requestError(dataResult()) ? "Your budget couldn’t be loaded." : null}
        onRetry={() => {
          void refetch();
        }}
      >
        <Show
          when={activeAccounts().length > 0}
          fallback={
            <div class="first-step">
              <span class="first-step-icon">
                <MoneyIcon name="accounts" size={36} />
              </span>
              <h2>Your money, your plan.</h2>
              <A class="btn btn-primary" href="/accounts?new=1">
                <MoneyIcon name="plus" />
                Add an account
              </A>
            </div>
          }
        >
          <div class="daily-layout">
            <div class="daily-main">
              <div class="daily-summary">
                <div>
                  <span class="metric-label">Available in categories</span>
                  <strong
                    class={`daily-total ${privacy().blurClass()}`}
                    classList={{ negative: available() < 0 }}
                  >
                    {fmt().formatCents(available())}
                  </strong>
                </div>
                <div class="daily-summary-side">
                  <span>{df().formatMonth(month).split(" ")[0]}</span>
                  <strong class={privacy().blurClass()}>{fmt().formatCents(spent())} spent</strong>
                  <A href="/budget">
                    Open budget <MoneyIcon name="arrow" size={15} />
                  </A>
                </div>
              </div>
              <Show when={overspent().length > 0 || (data()?.budget.toBudget ?? 0) !== 0}>
                <div class="daily-notices">
                  <Show when={overspent().length > 0}>
                    <button
                      class="notice notice-danger"
                      onClick={() => setParams({ category: overspent()[0]?.categoryId })}
                    >
                      <span class="notice-dot" />
                      <strong>{overspent().length} overspent</strong>
                      <span class={privacy().blurClass()}>
                        {fmt().formatCents(
                          -overspent().reduce((total, category) => total + category.leftover, 0),
                        )}
                      </span>
                      <MoneyIcon name="arrow" size={16} />
                    </button>
                  </Show>
                  <Show when={(data()?.budget.toBudget ?? 0) !== 0}>
                    <A
                      class="notice"
                      classList={{ "notice-danger": (data()?.budget.toBudget ?? 0) < 0 }}
                      href="/budget"
                    >
                      <span class="notice-dot" />
                      <strong>
                        {(data()?.budget.toBudget ?? 0) < 0 ? "Overassigned" : "To assign"}
                      </strong>
                      <span class={privacy().blurClass()}>
                        {fmt().formatCents(Math.abs(data()?.budget.toBudget ?? 0))}
                      </span>
                      <MoneyIcon name="arrow" size={16} />
                    </A>
                  </Show>
                </div>
              </Show>
              <div class="section-heading">
                <h2>Your categories</h2>
                <label class="compact-search">
                  <MoneyIcon name="search" size={17} />
                  <input
                    type="search"
                    aria-label="Find a category"
                    placeholder="Find category"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div class="filter-chips" aria-label="Category groups">
                <button classList={{ active: group() === null }} onClick={() => setGroup(null)}>
                  All
                </button>
                <For each={groups()}>
                  {(name) => (
                    <button classList={{ active: group() === name }} onClick={() => setGroup(name)}>
                      {name}
                    </button>
                  )}
                </For>
              </div>
              <Show
                when={categories().length}
                fallback={
                  <div class="first-step first-step-small">
                    <MoneyIcon name="budget" size={32} />
                    <h3>Make room for what matters.</h3>
                    <A href="/budget?new=1" class="btn btn-primary">
                      Add a category
                    </A>
                  </div>
                }
              >
                <Show
                  when={visible().length}
                  fallback={<p class="quiet-empty">No matching categories</p>}
                >
                  <div class="envelope-grid">
                    <For each={visible()}>
                      {(category) => (
                        <button
                          type="button"
                          class="envelope-card"
                          classList={{ "is-overspent": category.leftover < 0 }}
                          onClick={() => setParams({ category: category.categoryId })}
                          aria-label={`${category.categoryName}, ${fmt().formatCents(category.leftover)} available`}
                        >
                          <div class="envelope-card-top">
                            <CategoryBadge
                              name={category.categoryName}
                              icon={
                                data()?.definitions.find(
                                  (definition) => definition.id === category.categoryId,
                                )?.icon
                              }
                            />
                            <MoneyIcon name="arrow" size={17} />
                          </div>
                          <span class="envelope-name">{category.categoryName}</span>
                          <strong class={`envelope-amount ${privacy().blurClass()}`}>
                            {fmt().formatCents(category.leftover)}
                          </strong>
                          <span class="envelope-label">
                            {category.leftover < 0 ? "Overspent" : "Available"}
                          </span>
                          <div class="envelope-meter">
                            <span style={{ width: `${availableRatio(category) * 100}%` }} />
                          </div>
                          <span class={`envelope-spent ${privacy().blurClass()}`}>
                            {fmt().formatCents(Math.max(0, -category.spent))} spent
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
              <section class="home-accounts">
                <div class="section-heading">
                  <h2>Accounts</h2>
                  <A class="text-button" href="/accounts">
                    All accounts <MoneyIcon name="arrow" size={15} />
                  </A>
                </div>
                <div class="home-account-list">
                  <For each={activeAccounts()}>
                    {(account) => (
                      <A class="home-account" href={`/accounts/${account.id}`}>
                        <MoneyIcon name="accounts" />
                        <span>{account.name}</span>
                        <strong class={privacy().blurClass()}>
                          {fmt().formatCents(account.balanceCurrent)}
                        </strong>
                      </A>
                    )}
                  </For>
                </div>
              </section>
            </div>
            <aside class="daily-rail">
              <section class="rail-section">
                <div class="section-heading">
                  <h2>Recent activity</h2>
                  <A class="text-button" href="/transactions" aria-label="All activity">
                    <MoneyIcon name="arrow" size={17} />
                  </A>
                </div>
                <Show
                  when={!activityResult.loading || activity()}
                  fallback={
                    <p class="quiet-empty" role="status">
                      Loading…
                    </p>
                  }
                >
                  <Show
                    when={!requestError(activityResult())}
                    fallback={
                      <button class="btn btn-secondary" onClick={() => refetchActivity()}>
                        Retry activity
                      </button>
                    }
                  >
                    <Show when={uncategorized() > 0}>
                      <A class="review-link" href="/transactions?view=uncategorized">
                        To categorize <span>{uncategorized()}</span>
                        <MoneyIcon name="arrow" size={15} />
                      </A>
                    </Show>
                    <Show
                      when={recent().length}
                      fallback={<p class="quiet-empty">No transactions yet</p>}
                    >
                      <div class="daily-activity">
                        <For each={recent()}>
                          {(transaction) => (
                            <A
                              class="daily-activity-row"
                              href={`/transactions?focus=${encodeURIComponent(transaction.id)}`}
                            >
                              <span
                                class={`activity-avatar tone-${categoryTone(transaction.payee ?? "")}`}
                              >
                                {(transaction.payee ?? "—").slice(0, 1).toUpperCase()}
                              </span>
                              <span class="activity-description">
                                <strong>
                                  {transaction.payee ?? transaction.notes ?? "Transaction"}
                                </strong>
                                <small>
                                  {transaction.categoryName ??
                                    (transaction.transferId ? "Transfer" : "Uncategorized")}
                                </small>
                              </span>
                              <span class="activity-end">
                                <strong
                                  class={privacy().blurClass()}
                                  classList={{ positive: transaction.amount > 0 }}
                                >
                                  {fmt().formatCents(transaction.amount)}
                                </strong>
                                <small>{df().formatDate(transaction.date)}</small>
                              </span>
                            </A>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </section>
              <section class="rail-section">
                <div class="section-heading">
                  <h2>Coming up</h2>
                  <A class="text-button" href="/schedules" aria-label="All scheduled transactions">
                    <MoneyIcon name="arrow" size={17} />
                  </A>
                </div>
                <Show
                  when={!schedulesResult.loading || schedules()}
                  fallback={
                    <p class="quiet-empty" role="status">
                      Loading…
                    </p>
                  }
                >
                  <Show
                    when={!requestError(schedulesResult())}
                    fallback={
                      <button class="btn btn-secondary" onClick={() => refetchSchedules()}>
                        Retry upcoming
                      </button>
                    }
                  >
                    <Show
                      when={upcoming().length}
                      fallback={<p class="quiet-empty">Nothing scheduled</p>}
                    >
                      <div class="upcoming-list">
                        <For each={upcoming()}>
                          {(schedule) => (
                            <A
                              class="upcoming-row"
                              classList={{
                                "is-overdue":
                                  (schedule.nextDate ?? "") < formatCalendarDate(new Date()),
                              }}
                              href={`/schedules/${schedule.id}`}
                            >
                              <span class="date-tile">
                                <small>
                                  {new Intl.DateTimeFormat(undefined, { month: "short" }).format(
                                    new Date(`${schedule.nextDate}T12:00:00`),
                                  )}
                                </small>
                                <strong>{Number(schedule.nextDate?.slice(8, 10))}</strong>
                              </span>
                              <span>
                                <strong>{schedule.name ?? "Scheduled transaction"}</strong>
                                <small>
                                  {(schedule.nextDate ?? "") < formatCalendarDate(new Date())
                                    ? "Overdue"
                                    : df().formatDate(schedule.nextDate)}
                                </small>
                              </span>
                              <strong class={privacy().blurClass()}>
                                {schedule.amount === null
                                  ? "—"
                                  : fmt().formatCents(schedule.amount)}
                              </strong>
                            </A>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </section>
            </aside>
          </div>
        </Show>
      </PageState>
      <Show when={selected()} keyed>
        {(category) => (
          <CategoryDrawer
            month={month}
            category={category}
            definition={data()?.definitions.find(
              (definition) => definition.id === category.categoryId,
            )}
            categories={categories()}
            onClose={() => setParams({ category: undefined })}
          />
        )}
      </Show>
    </div>
  );
}
