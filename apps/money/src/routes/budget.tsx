import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { currentMonthKey, shiftMonth, expenseCategories } from "../lib/budget-view";
import { toMonthInt } from "../domain/types";
import MoneyIcon from "../components/MoneyIcon";
import MoneyDialog from "../components/MoneyDialog";
import MoveMoneyDialog from "../components/MoveMoneyDialog";
import BudgetReference from "../components/BudgetReference";
import MonthlyPlanDialog from "../components/MonthlyPlanDialog";
import { monthlyPlan } from "../lib/monthly-plan";
import CategoryDrawer from "../components/CategoryDrawer";
import { PageState } from "../components/PageState";
import CategoryBadge from "../components/CategoryBadge";
import CategoryIconPicker from "../components/CategoryIconPicker";
import type { CategoryIcon } from "../domain/category-icons";

type Assignment =
  | { state: "idle" }
  | { state: "saving"; categoryId: string }
  | { state: "failed"; categoryId: string; amount: number; previous: number; error: string };

export default function BudgetPage() {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [params, setParams] = useSearchParams<{
    category?: string;
    month?: string;
    new?: string;
  }>();
  const month = createMemo(() =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month ?? "")
      ? (params.month ?? currentMonthKey())
      : currentMonthKey(),
  );
  const previousMonth = createMemo(() => shiftMonth(month(), -1));
  const [query, setQuery] = createSignal("");
  const [revealed, setRevealed] = createSignal<string | null>(null);
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
  const [dataResult, { refetch }] = createResource(month, (key) =>
    loadRequest(async () => {
      const [budget, categories, groups] = await Promise.all([
        api.budgetMonth(toMonthInt(key)),
        api.categories(),
        api.categoryGroups(),
      ]);
      return { budget, definitions: categories.categories, groups: groups.groups };
    }),
  );
  const [previousResult, { refetch: refetchPrevious }] = createResource(previousMonth, (key) =>
    loadRequest(async () => ({ month: key, budget: await api.budgetMonth(toMonthInt(key)) })),
  );
  const previous = () => {
    const value = requestValue(previousResult());
    return value?.month === previousMonth() ? value.budget : undefined;
  };
  const data = () => requestValue(dataResult());
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        void refetch();
        void refetchPrevious();
      }),
    ),
  );
  const categories = createMemo(() =>
    expenseCategories(data()?.budget.categories ?? [], data()?.definitions ?? []),
  );
  const selected = createMemo(() =>
    categories().find((category) => category.categoryId === params.category),
  );
  const visible = createMemo(() =>
    categories().filter((category) =>
      category.categoryName.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
    ),
  );
  const grouped = createMemo(() =>
    [...new Set(visible().map((category) => category.groupName ?? "Other"))].map((name) => ({
      name,
      rows: visible().filter((category) => (category.groupName ?? "Other") === name),
    })),
  );
  const totalAssigned = createMemo(() =>
    categories().reduce((sum, category) => sum + category.budgeted, 0),
  );
  async function copyLastMonth() {
    const budget = data();
    const last = previous();
    if (!budget || !last || busy() || assignment().state === "saving") return;
    const rows = monthlyPlan(
      budget.budget.categories,
      budget.definitions,
      last.categories,
      "previous",
    );
    if (!rows.length) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "set_budget_plan",
        {
          month: month(),
          assignments: rows.map((row) => ({
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
                assignments: rows.map((row) => ({
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
  function moveMonth(offset: number) {
    if (busy() || assignment().state === "saving") return;
    const next = shiftMonth(month(), offset);
    setAssignment({ state: "idle" });
    setRevealed(null);
    setError(null);
    setParams({ month: next, category: undefined });
  }
  async function assign(categoryId: string, amount: number, previous: number) {
    if (amount === previous || assignment().state === "saving") return;
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
              payload: { month: toMonthInt(key), categoryId, amount: previous },
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
        previous,
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
  async function saveBuffer(event: SubmitEvent) {
    event.preventDefault();
    const amount = fmt().parseInput(bufferAmount());
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setError("Enter a positive amount or zero.");
      return;
    }
    const previous = data()?.budget.buffered ?? 0;
    if (amount - previous > Math.max(0, data()?.budget.toBudget ?? 0)) {
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
            inverse: { commandType: "set_buffer", payload: { month: month(), amount: previous } },
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
  return (
    <div class="page planning-page">
      <div class="page-header">
        <h1 class="page-title">Budget</h1>
        <div class="page-actions">
          <button
            class="btn btn-primary"
            onClick={() => {
              setError(null);
              setNewCategory(true);
            }}
            disabled={dataResult.loading}
          >
            <MoneyIcon name="plus" />
            Category
          </button>
        </div>
      </div>
      <div class="planning-month">
        <div class="month-nav">
          <button
            class="btn btn-icon btn-ghost"
            aria-label="Previous month"
            onClick={() => moveMonth(-1)}
            disabled={busy() || assignment().state === "saving"}
          >
            ‹
          </button>
          <h2>{df().formatMonth(month())}</h2>
          <button
            class="btn btn-icon btn-ghost"
            aria-label="Next month"
            onClick={() => moveMonth(1)}
            disabled={busy() || assignment().state === "saving"}
          >
            ›
          </button>
        </div>
        <Show when={month() !== currentMonthKey()}>
          <button
            class="text-button"
            onClick={() => {
              setParams({ month: undefined, category: undefined });
            }}
            disabled={busy() || assignment().state === "saving"}
          >
            This month
          </button>
        </Show>
      </div>
      <PageState
        loading={dataResult.loading}
        error={requestError(dataResult()) ? "This month’s budget couldn’t be loaded." : null}
        onRetry={() => {
          void refetch();
        }}
      >
        <div class="plan-summary">
          <span class="metric-label">Monthly budget</span>
          <strong class={privacy().blurClass()}>{fmt().formatCents(totalAssigned())}</strong>
        </div>
        <div class="plan-tools">
          <div class="plan-tool-actions">
            <label class="compact-search">
              <MoneyIcon name="search" size={17} />
              <input
                aria-label="Find a budget category"
                type="search"
                placeholder="Find category"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <details class="entity-menu">
              <summary aria-label="Budget actions">
                <MoneyIcon name="more" />
              </summary>
              <div class="entity-menu-popover">
                <button
                  onClick={() => void copyLastMonth()}
                  disabled={busy() || !previous() || assignment().state === "saving"}
                >
                  Copy last month
                </button>
                <button onClick={() => setPlanning(true)} disabled={busy()}>
                  Fund targets
                </button>
                <button onClick={() => setMoving(true)} disabled={!categories().length || busy()}>
                  Move money
                </button>
                <button
                  onClick={() => {
                    setError(null);
                    setBufferAmount(fmt().formatCentsInput(data()?.budget.buffered ?? 0));
                    setBuffering(true);
                  }}
                >
                  Hold for next month
                </button>
                <A href="/categories">Organize categories</A>
              </div>
            </details>
          </div>
        </div>
        <Show when={previousResult.loading}>
          <div class="plan-comparison-state" role="status">
            Loading last month…
          </div>
        </Show>
        <Show when={requestError(previousResult())}>
          <div class="assignment-error" role="alert">
            <span>Last month couldn’t be loaded.</span>
            <button class="btn btn-secondary btn-sm" onClick={() => void refetchPrevious()}>
              Retry comparison
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
            <div class="assignment-error" role="alert">
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
            fallback={<p class="quiet-empty">No matching categories</p>}
          >
            <div class="plan-table">
              <div class="plan-table-header">
                <span>Category</span>
                <span>Budget</span>
              </div>
              <For each={grouped()}>
                {(group) => (
                  <section class="plan-group">
                    <div class="plan-group-heading">
                      <h3>{group.name}</h3>
                      <strong class={privacy().blurClass()}>
                        {fmt().formatCents(
                          group.rows.reduce((sum, category) => sum + category.budgeted, 0),
                        )}
                      </strong>
                    </div>
                    <For each={group.rows}>
                      {(category) => {
                        const last = () =>
                          previous()?.categories.find(
                            (row) =>
                              row.categoryId === category.categoryId &&
                              (row.budgeted !== 0 || row.spent !== 0),
                          );
                        return (
                          <div class="plan-row">
                            <div class="plan-category-cell">
                              <button
                                class="plan-category"
                                onClick={() => setParams({ category: category.categoryId })}
                              >
                                <span class="plan-category-label">
                                  <CategoryBadge
                                    name={category.categoryName}
                                    icon={
                                      data()?.definitions.find(
                                        (definition) => definition.id === category.categoryId,
                                      )?.icon
                                    }
                                    small
                                  />
                                  <span>{category.categoryName}</span>
                                </span>
                              </button>
                              <Show when={last()}>
                                <button
                                  type="button"
                                  class="plan-history-toggle"
                                  aria-label={
                                    (revealed() === category.categoryId ? "Hide" : "Show") +
                                    " last month for " +
                                    category.categoryName
                                  }
                                  aria-expanded={revealed() === category.categoryId}
                                  aria-controls={"history-" + category.categoryId}
                                  onClick={() =>
                                    setRevealed((id) =>
                                      id === category.categoryId ? null : category.categoryId,
                                    )
                                  }
                                >
                                  <MoneyIcon name="chevron" size={14} />
                                </button>
                              </Show>
                            </div>
                            <label class="plan-assigned">
                              <span class="mobile-column-label">Budget</span>
                              <input
                                aria-label={`Budget for ${category.categoryName}`}
                                type="text"
                                inputmode={fmt().inputMode}
                                class={privacy().blurClass()}
                                value={fmt().formatCentsInput(category.budgeted)}
                                disabled={assignment().state === "saving" || busy()}
                                onBlur={(event) => {
                                  void assign(
                                    category.categoryId,
                                    fmt().parseInput(event.currentTarget.value),
                                    category.budgeted,
                                  );
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                              />
                            </label>
                            <Show when={revealed() === category.categoryId && last()}>
                              {(previousCategory) => (
                                <BudgetReference
                                  id={"history-" + category.categoryId}
                                  month={previousMonth()}
                                  category={previousCategory()}
                                  disabled={
                                    busy() ||
                                    assignment().state === "saving" ||
                                    category.budgeted === previousCategory().budgeted
                                  }
                                  onCopy={() =>
                                    void assign(
                                      category.categoryId,
                                      previousCategory().budgeted,
                                      category.budgeted,
                                    )
                                  }
                                />
                              )}
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </section>
                )}
              </For>
              <div class="plan-table-total">
                <strong>Total</strong>
                <strong class={privacy().blurClass()}>
                  {fmt().formatCents(
                    visible().reduce((sum, category) => sum + category.budgeted, 0),
                  )}
                </strong>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={(data()?.budget.buffered ?? 0) > 0}>
          <button
            class="held-money"
            onClick={() => {
              setError(null);
              setBufferAmount(fmt().formatCentsInput(data()?.budget.buffered ?? 0));
              setBuffering(true);
            }}
          >
            <MoneyIcon name="calendar" />
            <span>Held for next month</span>
            <strong class={privacy().blurClass()}>
              {fmt().formatCents(data()?.budget.buffered ?? 0)}
            </strong>
            <MoneyIcon name="arrow" size={16} />
          </button>
        </Show>
      </PageState>
      <Show when={selected()} keyed>
        {(category) => (
          <CategoryDrawer
            month={month()}
            category={category}
            definition={data()?.definitions.find(
              (definition) => definition.id === category.categoryId,
            )}
            categories={categories()}
            onClose={() => setParams({ category: undefined })}
          />
        )}
      </Show>
      <Show when={planning()}>
        <MonthlyPlanDialog
          month={month()}
          budget={data()!.budget}
          definitions={data()!.definitions}
          onClose={() => setPlanning(false)}
        />
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
