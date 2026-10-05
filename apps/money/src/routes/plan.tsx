import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import {
  availableRatio,
  currentMonthKey,
  expenseCategories,
  readGoal,
  shiftMonth,
  type BudgetCategory,
} from "../lib/budget-view";
import { monthlyPlan } from "../lib/monthly-plan";
import { paymentOccurrences } from "../lib/recurring-view";
import { monthBoundaries, toMonthInt } from "../domain/types";
import MoneyIcon from "../components/MoneyIcon";
import MoneyDialog from "../components/MoneyDialog";
import MoveMoneyDialog from "../components/MoveMoneyDialog";
import MonthlyPlanDialog from "../components/MonthlyPlanDialog";
import CategoryDrawer from "../components/CategoryDrawer";
import RecurringPanel from "../components/RecurringPanel";
import CashFlowPanel from "../components/CashFlowPanel";
import { PageState } from "../components/PageState";
import CategoryBadge from "../components/CategoryBadge";
import CategoryIconPicker from "../components/CategoryIconPicker";
import type { CategoryIcon } from "../domain/category-icons";

type Assignment =
  | { state: "idle" }
  | { state: "saving"; categoryId: string }
  | { state: "failed"; categoryId: string; amount: number; previous: number; error: string };

type RowView = "all" | "attention" | "active";

type PlanRow = {
  category: BudgetCategory;
  spent: number;
  scheduled: number;
  lastSpent: number | null;
  lastAssigned: number | null;
  target: { label: string; shortfall: number } | null;
  short: number;
};

function sumRows(rows: readonly PlanRow[]) {
  return rows.reduce(
    (total, row) => ({
      budgeted: total.budgeted + row.category.budgeted,
      spent: total.spent + row.spent,
      available: total.available + row.category.leftover,
      scheduled: total.scheduled + row.scheduled,
      lastSpent: total.lastSpent + (row.lastSpent ?? 0),
    }),
    { budgeted: 0, spent: 0, available: 0, scheduled: 0, lastSpent: 0 },
  );
}

export default function PlanPage() {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [params, setParams] = useSearchParams<{
    category?: string;
    month?: string;
    new?: string;
    payment?: string;
  }>();
  const month = createMemo(() =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month ?? "")
      ? (params.month ?? currentMonthKey())
      : currentMonthKey(),
  );
  const previousMonth = createMemo(() => shiftMonth(month(), -1));
  const [query, setQuery] = createSignal("");
  const [rowView, setRowView] = createSignal<RowView>("all");
  const [planning, setPlanning] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  const [newCategory, setNewCategory] = createSignal(params.new === "1");
  const [buffering, setBuffering] = createSignal(false);
  const [name, setName] = createSignal("");
  const [icon, setIcon] = createSignal<CategoryIcon | null>(null);
  const [groupId, setGroupId] = createSignal("");
  const [bufferAmount, setBufferAmount] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [assignment, setAssignment] = createSignal<Assignment>({ state: "idle" });
  const failedAssignment = createMemo(() => {
    const value = assignment();
    return value.state === "failed" ? value : null;
  });
  const locked = () => busy() || assignment().state === "saving";

  const [dataResult, { refetch }] = createResource(month, (key) =>
    loadRequest(async () => {
      const [budget, categories, groups] = await Promise.all([
        api.budgetMonth(toMonthInt(key)),
        api.categories(),
        api.categoryGroups(),
      ]);
      return { month: key, budget, definitions: categories.categories, groups: groups.groups };
    }),
  );
  const data = () => {
    const value = requestValue(dataResult());
    return value?.month === month() ? value : undefined;
  };
  const [previousResult, { refetch: refetchPrevious }] = createResource(previousMonth, (key) =>
    loadRequest(async () => ({ month: key, budget: await api.budgetMonth(toMonthInt(key)) })),
  );
  const previous = () => {
    const value = requestValue(previousResult());
    return value?.month === previousMonth() ? value.budget : undefined;
  };
  const [reportResult, { refetch: refetchReport }] = createResource(month, (key) =>
    loadRequest(() => api.reports.monthly(key)),
  );
  const report = () => {
    const value = requestValue(reportResult());
    return value?.month === month() ? value : undefined;
  };
  const [recurringResult, { refetch: refetchRecurring }] = createResource(() =>
    loadRequest(async () => {
      const [schedules, accounts, categories] = await Promise.all([
        api.schedules(),
        api.accounts(),
        api.categories(),
      ]);
      return {
        payments: schedules.schedules,
        accounts: accounts.accounts,
        categories: categories.categories,
      };
    }),
  );
  const recurring = () => requestValue(recurringResult());
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        void refetch();
        void refetchPrevious();
        void refetchReport();
        void refetchRecurring();
      }),
    ),
  );

  const categories = createMemo(() =>
    expenseCategories(data()?.budget.categories ?? [], data()?.definitions ?? []),
  );
  const definitionFor = (id: string) => data()?.definitions.find((row) => row.id === id);
  /** Scheduled spending per category still to pay in this month; the current month includes overdue. */
  const scheduledByCategory = createMemo(() => {
    const totals = new Map<string, number>();
    if (month() < currentMonthKey()) return totals;
    const { start, end } = monthBoundaries(month());
    const from = month() === currentMonthKey() ? "0000-01-01" : start;
    for (const payment of recurring()?.payments ?? []) {
      if (!payment.categoryId || payment.amount === null || payment.amount >= 0) continue;
      const count = paymentOccurrences(payment, from, end).length;
      if (count)
        totals.set(
          payment.categoryId,
          (totals.get(payment.categoryId) ?? 0) - payment.amount * count,
        );
    }
    return totals;
  });
  /** Scheduled money still expected in this month; information only until it's recorded. */
  const expectedIncome = createMemo(() => {
    if (month() < currentMonthKey()) return 0;
    const { start, end } = monthBoundaries(month());
    const from = month() === currentMonthKey() ? "0000-01-01" : start;
    return (recurring()?.payments ?? []).reduce(
      (sum, payment) =>
        payment.amount !== null && payment.amount > 0
          ? sum + payment.amount * paymentOccurrences(payment, from, end).length
          : sum,
      0,
    );
  });
  const rows = createMemo<PlanRow[]>(() =>
    categories().map((category) => {
      const last = previous()?.categories.find((row) => row.categoryId === category.categoryId);
      const goal = readGoal(definitionFor(category.categoryId)?.goalDef);
      const scheduled = scheduledByCategory().get(category.categoryId) ?? 0;
      const target =
        goal && goal.type !== "percentage" && goal.amount
          ? {
              label:
                goal.type === "monthly"
                  ? `${fmt().formatCents(goal.amount)}/mo`
                  : goal.type === "byDate" && goal.targetDate
                    ? `${fmt().formatCents(goal.amount)} by ${df().formatMonth(goal.targetDate.slice(0, 7)).slice(0, 3)} ${goal.targetDate.slice(2, 4)}`
                    : goal.type === "refill"
                      ? `Refill to ${fmt().formatCents(goal.amount)}`
                      : fmt().formatCents(goal.amount),
              shortfall:
                goal.type === "monthly"
                  ? Math.max(0, goal.amount - category.budgeted)
                  : goal.type === "refill"
                    ? Math.max(0, goal.amount - category.leftover)
                    : 0,
            }
          : goal?.type === "percentage"
            ? { label: `${goal.percentage ?? 0}% of income`, shortfall: 0 }
            : null;
      return {
        category,
        spent: Math.max(0, -category.spent),
        scheduled,
        lastSpent: last ? Math.max(0, -last.spent) : null,
        lastAssigned: last ? last.budgeted : null,
        target,
        short: Math.max(0, scheduled - Math.max(0, category.leftover)),
      };
    }),
  );
  const needsAttention = (row: PlanRow) =>
    row.category.leftover < 0 || row.short > 0 || (row.target?.shortfall ?? 0) > 0;
  const visible = createMemo(() => {
    const search = query().trim().toLocaleLowerCase();
    return rows().filter(
      (row) =>
        row.category.categoryName.toLocaleLowerCase().includes(search) &&
        (rowView() === "all" ||
          (rowView() === "attention" && needsAttention(row)) ||
          (rowView() === "active" && (row.spent > 0 || row.category.budgeted !== 0))),
    );
  });
  const grouped = createMemo(() =>
    [...new Set(visible().map((row) => row.category.groupName ?? "Other"))].map((group) => ({
      name: group,
      rows: visible().filter((row) => (row.category.groupName ?? "Other") === group),
    })),
  );
  const totals = createMemo(() => sumRows(rows()));
  const attentionCount = createMemo(() => rows().filter(needsAttention).length);
  const toBudget = () => data()?.budget.toBudget ?? 0;
  /** Where To assign came from beyond this month's income, so rollover is visible. */
  const toBudgetSources = () => {
    const budget = data()?.budget;
    if (!budget) return null;
    const lastMonth = df().formatMonth(previousMonth()).slice(0, 3);
    const parts: string[] = [];
    if (budget.fromLastMonth !== 0) parts.push(`${money(budget.fromLastMonth)} from ${lastMonth}`);
    if (budget.overspentLastMonth > 0) parts.push(`−${money(budget.overspentLastMonth)} overspent`);
    if (budget.buffered > 0) parts.push(`${money(budget.buffered)} held for next month`);
    return parts.length ? parts.join(" · ") : null;
  };
  const selected = createMemo(() =>
    categories().find((category) => category.categoryId === params.category),
  );

  async function copyLastMonth() {
    const budget = data();
    const last = previous();
    if (!budget || !last || locked()) return;
    const plan = monthlyPlan(
      budget.budget.categories,
      budget.definitions,
      last.categories,
      "previous",
    );
    if (!plan.length) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "set_budget_plan",
        {
          month: month(),
          assignments: plan.map((row) => ({
            categoryId: row.category.categoryId,
            amount: row.target,
          })),
        },
        {
          undoInfo: {
            label: "Budget copied from last month",
            inverse: {
              commandType: "set_budget_plan",
              payload: {
                month: month(),
                assignments: plan.map((row) => ({
                  categoryId: row.category.categoryId,
                  amount: row.category.budgeted,
                })),
              },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not copy last month");
    } finally {
      setBusy(false);
    }
  }
  function moveMonth(next: string | undefined) {
    if (locked()) return;
    setAssignment({ state: "idle" });
    setError(null);
    setParams({ month: next, category: undefined });
  }
  async function assign(categoryId: string, amount: number, previousAmount: number) {
    if (amount === previousAmount || assignment().state === "saving") return;
    if (!Number.isSafeInteger(amount)) {
      setError("Enter a valid amount.");
      return;
    }
    setError(null);
    const key = month();
    setAssignment({ state: "saving", categoryId });
    try {
      await dispatch(
        "set_budget_amount",
        { month: toMonthInt(key), categoryId, amount },
        {
          undoInfo: {
            label: "Assign money",
            inverse: {
              commandType: "set_budget_amount",
              payload: { month: toMonthInt(key), categoryId, amount: previousAmount },
            },
          },
        },
      ).promise;
      setAssignment({ state: "idle" });
      emitMoneyDataChanged();
    } catch (caught) {
      setAssignment({
        state: "failed",
        categoryId,
        amount,
        previous: previousAmount,
        error: caught instanceof Error ? caught.message : "Could not save",
      });
    }
  }
  async function createCategory(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "create_category",
        { name: name().trim(), groupId: groupId() || null, icon: icon() },
        {
          undoInfo: {
            label: "Create category",
            inverse: (result) => ({
              commandType: "delete_category",
              payload: { id: requireCommandId(result) },
            }),
          },
        },
      ).promise;
      setNewCategory(false);
      setParams({ new: undefined });
      setName("");
      setIcon(null);
      emitMoneyDataChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create category");
    } finally {
      setBusy(false);
    }
  }
  function openBuffer() {
    setError(null);
    setBufferAmount(fmt().formatCentsInput(data()?.budget.buffered ?? 0));
    setBuffering(true);
  }
  async function saveBuffer(event: SubmitEvent) {
    event.preventDefault();
    const amount = fmt().parseInput(bufferAmount());
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setError("Enter a positive amount or zero.");
      return;
    }
    const held = data()?.budget.buffered ?? 0;
    if (amount - held > Math.max(0, toBudget())) {
      setError("That’s more than you have left to assign.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "set_buffer",
        { month: month(), amount },
        {
          undoInfo: {
            label: "Hold for next month",
            inverse: { commandType: "set_buffer", payload: { month: month(), amount: held } },
          },
        },
      ).promise;
      setBuffering(false);
      emitMoneyDataChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not hold money");
    } finally {
      setBusy(false);
    }
  }

  function money(cents: number) {
    return fmt().formatCents(cents);
  }

  function planRow(row: PlanRow) {
    const category = row.category;
    const ratio = () => availableRatio(category);
    const copyable = () =>
      row.lastAssigned !== null && row.lastAssigned !== category.budgeted && !locked();
    return (
      <div
        class="plan-grid-row"
        classList={{
          "is-overspent": category.leftover < 0,
          "is-short": category.leftover >= 0 && row.short > 0,
          "is-saving": (() => {
            const current = assignment();
            return current.state === "saving" && current.categoryId === category.categoryId;
          })(),
        }}
      >
        <button
          type="button"
          class="pg-category"
          onClick={() => setParams({ category: category.categoryId })}
        >
          <CategoryBadge
            name={category.categoryName}
            icon={definitionFor(category.categoryId)?.icon}
            small
          />
          <span class="pg-category-name">
            <strong>{category.categoryName}</strong>
            <span class="pg-meter" aria-hidden="true">
              <span
                classList={{ "is-overspent": category.leftover < 0 }}
                style={{ width: `${category.leftover < 0 ? 100 : ratio() * 100}%` }}
              />
            </span>
          </span>
        </button>
        <label class="pg-cell pg-assigned">
          <span class="pg-cell-label">Assigned</span>
          <input
            aria-label={`Budget for ${category.categoryName}`}
            type="text"
            inputmode={fmt().inputMode}
            class={privacy().blurClass()}
            value={fmt().formatCentsInput(category.budgeted)}
            disabled={locked()}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => {
              void assign(
                category.categoryId,
                fmt().parseInput(event.currentTarget.value),
                category.budgeted,
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = fmt().formatCentsInput(category.budgeted);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <span class={`pg-cell pg-num ${privacy().blurClass()}`}>
          <span class="pg-cell-label">Spent</span>
          {row.spent ? money(row.spent) : "—"}
        </span>
        <span
          class={`pg-cell pg-num pg-available ${privacy().blurClass()}`}
          classList={{
            negative: category.leftover < 0,
            "is-short": category.leftover >= 0 && row.short > 0,
          }}
        >
          <span class="pg-cell-label">Available</span>
          {money(category.leftover)}
          <Show when={category.leftover >= 0 && row.short > 0}>
            <small title="Scheduled payments exceed what’s available">
              {money(row.short)} short
            </small>
          </Show>
        </span>
        <span class={`pg-cell pg-num pg-muted ${privacy().blurClass()}`}>
          <span class="pg-cell-label">Scheduled</span>
          {row.scheduled ? money(row.scheduled) : "—"}
        </span>
        <span class={`pg-cell pg-num pg-muted pg-last ${privacy().blurClass()}`}>
          <span class="pg-cell-label">Last month</span>
          <Show when={row.lastSpent || row.lastAssigned} fallback="—">
            <span
              title={`Assigned ${money(row.lastAssigned ?? 0)} · spent ${money(row.lastSpent ?? 0)}`}
            >
              {money(row.lastSpent ?? 0)}
              <small>of {money(row.lastAssigned ?? 0)}</small>
            </span>
            <button
              type="button"
              class="pg-copy"
              disabled={!copyable()}
              aria-label={`Use last month’s ${money(row.lastAssigned ?? 0)} for ${category.categoryName}`}
              title="Use last month’s assigned amount"
              onClick={() =>
                void assign(category.categoryId, row.lastAssigned ?? 0, category.budgeted)
              }
            >
              <MoneyIcon name="copy" size={13} />
            </button>
          </Show>
        </span>
        <span class="pg-cell pg-target">
          <span class="pg-cell-label">Target</span>
          <Show when={row.target} fallback={<span class="pg-muted">—</span>}>
            {(target) => (
              <>
                <span>{target().label}</span>
                <Show when={target().shortfall > 0}>
                  <small class={privacy().blurClass()}>needs {money(target().shortfall)}</small>
                </Show>
              </>
            )}
          </Show>
        </span>
      </div>
    );
  }

  return (
    <div class="page ws-page plan-page">
      <div class="ws-header">
        <div class="ws-title">
          <h1 class="page-title">Plan</h1>
          <div class="month-nav ws-month">
            <button
              class="btn btn-icon btn-ghost"
              aria-label="Previous month"
              onClick={() => moveMonth(shiftMonth(month(), -1))}
              disabled={locked()}
            >
              ‹
            </button>
            <h2>{df().formatMonth(month())}</h2>
            <button
              class="btn btn-icon btn-ghost"
              aria-label="Next month"
              onClick={() => moveMonth(shiftMonth(month(), 1))}
              disabled={locked()}
            >
              ›
            </button>
            <Show when={month() !== currentMonthKey()}>
              <button class="text-button" onClick={() => moveMonth(undefined)} disabled={locked()}>
                This month
              </button>
            </Show>
          </div>
        </div>
        <div class="page-actions ws-actions">
          <button
            class="btn btn-secondary btn-sm"
            onClick={() => void copyLastMonth()}
            disabled={locked() || !previous() || !data()}
            title="Set every category to last month’s assigned amount"
          >
            <MoneyIcon name="copy" size={15} />
            Copy last month
          </button>
          <button
            class="btn btn-secondary btn-sm"
            onClick={() => setPlanning(true)}
            disabled={locked() || !data()}
          >
            Fund targets
          </button>
          <button
            class="btn btn-secondary btn-sm"
            onClick={() => setMoving(true)}
            disabled={!categories().length || locked()}
          >
            <MoneyIcon name="move" size={15} />
            Move money
          </button>
          <details class="entity-menu">
            <summary aria-label="More plan actions">
              <MoneyIcon name="more" />
            </summary>
            <div
              class="entity-menu-popover"
              onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
            >
              <button
                onClick={() => {
                  setError(null);
                  setNewCategory(true);
                }}
                disabled={!data()}
              >
                New category
              </button>
              <button onClick={openBuffer} disabled={!data()}>
                Hold for next month
              </button>
              <A href="/categories">Organize categories</A>
            </div>
          </details>
        </div>
      </div>
      <PageState
        loading={dataResult.loading && !data()}
        error={requestError(dataResult()) ? "This month’s budget couldn’t be loaded." : null}
        onRetry={() => {
          void refetch();
        }}
      >
        <div class={`ws-stats ${privacy().blurClass()}`}>
          <button
            type="button"
            class="ws-stat ws-stat-primary"
            classList={{ "is-negative": toBudget() < 0, "is-done": toBudget() === 0 }}
            onClick={() => toBudget() > 0 && setPlanning(true)}
            title={toBudget() > 0 ? "Fund targets with what’s left" : undefined}
          >
            <span>{toBudget() < 0 ? "Overassigned" : "To assign"}</span>
            <strong>{money(Math.abs(toBudget()))}</strong>
            <Show when={toBudgetSources()}>{(line) => <small>{line()}</small>}</Show>
          </button>
          <div class="ws-stat">
            <span>Income</span>
            <strong class="money-in">
              <Show when={report()} fallback="—">
                {money(report()!.income)}
              </Show>
            </strong>
            <Show
              when={expectedIncome() > 0}
              fallback={
                <Show when={report()?.previous.transactionCount}>
                  <small>last month {money(report()!.previous.income)}</small>
                </Show>
              }
            >
              <small title="Scheduled income isn’t assignable until it arrives">
                +{money(expectedIncome())} still expected
              </small>
            </Show>
          </div>
          <div class="ws-stat">
            <span>Assigned</span>
            <strong>{money(totals().budgeted)}</strong>
            <Show when={previous()}>
              <small>
                last month{" "}
                {money(
                  expenseCategories(previous()!.categories, data()?.definitions ?? []).reduce(
                    (sum, row) => sum + row.budgeted,
                    0,
                  ),
                )}
              </small>
            </Show>
          </div>
          <div class="ws-stat">
            <span>Spent</span>
            <strong>{money(totals().spent)}</strong>
            <Show when={totals().lastSpent}>
              <small>last month {money(totals().lastSpent)}</small>
            </Show>
          </div>
          <div class="ws-stat">
            <span>Available</span>
            <strong classList={{ negative: totals().available < 0 }}>
              {money(totals().available)}
            </strong>
          </div>
          <div class="ws-stat">
            <span>Scheduled</span>
            <strong>{money(totals().scheduled)}</strong>
            <small>still to pay</small>
          </div>
          <div class="ws-stat">
            <span>Free after bills</span>
            <strong classList={{ negative: totals().available - totals().scheduled < 0 }}>
              {money(totals().available - totals().scheduled)}
            </strong>
          </div>
        </div>
        <div class="ws-grid">
          <div class="ws-main">
            <Show when={requestError(previousResult())}>
              <div class="ws-inline-error" role="alert">
                <span>Last month couldn’t be loaded.</span>
                <button class="btn btn-secondary btn-sm" onClick={() => void refetchPrevious()}>
                  Retry
                </button>
              </div>
            </Show>
            <Show when={requestError(recurringResult())}>
              <div class="ws-inline-error" role="alert">
                <span>Scheduled payments couldn’t be loaded.</span>
                <button class="btn btn-secondary btn-sm" onClick={() => void refetchRecurring()}>
                  Retry
                </button>
              </div>
            </Show>
            <Show when={error() && !newCategory() && !buffering()}>
              <p class="form-error" role="alert">
                {error()}
              </p>
            </Show>
            <Show when={failedAssignment()}>
              {(failed) => (
                <div class="ws-inline-error" role="alert">
                  <span>{failed().error}</span>
                  <button
                    class="btn btn-secondary btn-sm"
                    onClick={() => assign(failed().categoryId, failed().amount, failed().previous)}
                  >
                    Retry
                  </button>
                </div>
              )}
            </Show>
            <div class="ws-toolbar">
              <div class="filter-chips" aria-label="Category view">
                <button
                  classList={{ active: rowView() === "all" }}
                  onClick={() => setRowView("all")}
                >
                  All <span>{rows().length}</span>
                </button>
                <button
                  classList={{ active: rowView() === "attention" }}
                  onClick={() => setRowView("attention")}
                >
                  Needs attention <span>{attentionCount()}</span>
                </button>
                <button
                  classList={{ active: rowView() === "active" }}
                  onClick={() => setRowView("active")}
                >
                  In use
                </button>
              </div>
              <label class="compact-search">
                <MoneyIcon name="search" size={16} />
                <input
                  aria-label="Find a budget category"
                  type="search"
                  placeholder="Find category"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
            </div>
            <Show
              when={categories().length}
              fallback={
                <div class="first-step">
                  <MoneyIcon name="budget" size={36} />
                  <h2>No categories yet</h2>
                  <button class="btn btn-primary" onClick={() => setNewCategory(true)}>
                    <MoneyIcon name="plus" />
                    Add category
                  </button>
                </div>
              }
            >
              <Show
                when={visible().length}
                fallback={<p class="ws-empty">No matching categories</p>}
              >
                <div class="plan-grid" role="table" aria-label="Budget">
                  <div class="plan-grid-head" role="row">
                    <span>Category</span>
                    <span>Assigned</span>
                    <span>Spent</span>
                    <span>Available</span>
                    <span>Scheduled</span>
                    <span>Last month</span>
                    <span>Target</span>
                  </div>
                  <For each={grouped()}>
                    {(group) => {
                      const sums = () => sumRows(group.rows);
                      return (
                        <section class="plan-grid-group">
                          <div class={`plan-grid-group-head ${privacy().blurClass()}`}>
                            <h3>{group.name}</h3>
                            <span>{money(sums().budgeted)}</span>
                            <span>{money(sums().spent)}</span>
                            <span classList={{ negative: sums().available < 0 }}>
                              {money(sums().available)}
                            </span>
                            <span>{sums().scheduled ? money(sums().scheduled) : "—"}</span>
                            <span>{previous() ? money(sums().lastSpent) : "—"}</span>
                            <span />
                          </div>
                          <For each={group.rows}>{(row) => planRow(row)}</For>
                        </section>
                      );
                    }}
                  </For>
                  <div class={`plan-grid-total ${privacy().blurClass()}`}>
                    <strong>Total</strong>
                    <strong>{money(sumRows(visible()).budgeted)}</strong>
                    <strong>{money(sumRows(visible()).spent)}</strong>
                    <strong classList={{ negative: sumRows(visible()).available < 0 }}>
                      {money(sumRows(visible()).available)}
                    </strong>
                    <strong>{money(sumRows(visible()).scheduled)}</strong>
                    <strong>{previous() ? money(sumRows(visible()).lastSpent) : "—"}</strong>
                    <span />
                  </div>
                </div>
              </Show>
            </Show>
          </div>
          <aside class="ws-rail">
            <Show
              when={recurring()}
              fallback={
                <section class="ws-panel">
                  <div class="ws-panel-heading">
                    <h2>Recurring</h2>
                  </div>
                  <Show
                    when={requestError(recurringResult())}
                    fallback={
                      <p class="ws-empty" role="status">
                        Loading…
                      </p>
                    }
                  >
                    <button
                      class="btn btn-secondary btn-sm"
                      onClick={() => void refetchRecurring()}
                    >
                      Retry recurring
                    </button>
                  </Show>
                </section>
              }
            >
              {(loaded) => (
                <RecurringPanel
                  month={month()}
                  payments={loaded().payments}
                  accounts={loaded().accounts}
                  categories={loaded().categories}
                  focusId={params.payment}
                  onFocus={(id) => setParams({ payment: id }, { replace: !id })}
                />
              )}
            </Show>
            <CashFlowPanel month={month()} />
          </aside>
        </div>
      </PageState>
      <Show when={selected()} keyed>
        {(category) => (
          <CategoryDrawer
            month={month()}
            category={category}
            definition={definitionFor(category.categoryId)}
            categories={categories()}
            onClose={() => setParams({ category: undefined })}
          />
        )}
      </Show>
      <Show when={planning() && data()}>
        {(loaded) => (
          <MonthlyPlanDialog
            month={month()}
            budget={loaded().budget}
            definitions={loaded().definitions}
            onClose={() => setPlanning(false)}
          />
        )}
      </Show>
      <Show when={moving()}>
        <MoveMoneyDialog
          month={month()}
          categories={categories()}
          onClose={() => setMoving(false)}
        />
      </Show>
      <Show when={newCategory()}>
        <MoneyDialog
          title="New category"
          onClose={() => {
            setNewCategory(false);
            setParams({ new: undefined });
          }}
          busy={busy()}
        >
          <form class="money-form" onSubmit={createCategory}>
            <CategoryIconPicker name={name()} value={icon()} onChange={setIcon} disabled={busy()} />
            <div class="form-group">
              <label for="new-category-name">Name</label>
              <input
                id="new-category-name"
                autofocus
                required
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
                disabled={busy()}
              />
            </div>
            <div class="form-group">
              <label for="new-category-group">Group</label>
              <select
                id="new-category-group"
                value={groupId()}
                onChange={(event) => setGroupId(event.currentTarget.value)}
                disabled={busy()}
              >
                <option value="">Other</option>
                <For
                  each={(data()?.groups ?? []).filter((group) => !group.hidden && !group.isIncome)}
                >
                  {(group) => <option value={group.id}>{group.name}</option>}
                </For>
              </select>
            </div>
            <Show when={error()}>
              <p class="form-error" role="alert">
                {error()}
              </p>
            </Show>
            <button type="submit" class="btn btn-primary btn-full" disabled={busy()}>
              {busy() ? "Creating…" : "Add category"}
            </button>
          </form>
        </MoneyDialog>
      </Show>
      <Show when={buffering()}>
        <MoneyDialog title="Hold for next month" onClose={() => setBuffering(false)} busy={busy()}>
          <form class="money-form" onSubmit={saveBuffer}>
            <div class="form-group">
              <label for="hold-amount">Amount held</label>
              <input
                id="hold-amount"
                autofocus
                type="text"
                inputmode={fmt().inputMode}
                required
                value={bufferAmount()}
                onInput={(event) => setBufferAmount(event.currentTarget.value)}
                disabled={busy()}
              />
            </div>
            <Show when={error()}>
              <p class="form-error" role="alert">
                {error()}
              </p>
            </Show>
            <button type="submit" class="btn btn-primary btn-full" disabled={busy()}>
              {busy() ? "Saving…" : "Save"}
            </button>
          </form>
        </MoneyDialog>
      </Show>
    </div>
  );
}
