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
  currentMonthKey,
  shiftMonth,
  expenseCategories,
  monthlyTarget,
  type BudgetCategory,
} from "../lib/budget-view";
import { toMonthInt } from "../domain/types";
import MoneyIcon from "../components/MoneyIcon";
import MoneyDialog from "../components/MoneyDialog";
import MoveMoneyDialog from "../components/MoveMoneyDialog";
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
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<"all" | "overspent" | "target">("all");
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
  const data = () => requestValue(dataResult());
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        void refetch();
      }),
    ),
  );
  const categories = createMemo(() =>
    expenseCategories(data()?.budget.categories ?? [], data()?.definitions ?? []),
  );
  const selected = createMemo(() =>
    categories().find((category) => category.categoryId === params.category),
  );
  const targetFor = (category: BudgetCategory) =>
    monthlyTarget(
      data()?.definitions.find((definition) => definition.id === category.categoryId)?.goalDef,
    );
  const underTarget = createMemo(() =>
    categories().filter((category) => {
      const target = targetFor(category);
      return target !== null && category.budgeted < target;
    }),
  );
  const overspent = createMemo(() => categories().filter((category) => category.leftover < 0));
  const visible = createMemo(() =>
    categories().filter(
      (category) =>
        category.categoryName.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()) &&
        (filter() === "all" ||
          (filter() === "overspent"
            ? category.leftover < 0
            : (targetFor(category) ?? 0) > category.budgeted)),
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
  const totalSpent = createMemo(() =>
    categories().reduce((sum, category) => sum + Math.max(0, -category.spent), 0),
  );
  const totalAvailable = createMemo(() =>
    categories().reduce((sum, category) => sum + category.leftover, 0),
  );
  function moveMonth(offset: number) {
    if (busy() || assignment().state === "saving") return;
    const next = shiftMonth(month(), offset);
    setAssignment({ state: "idle" });
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
  async function copyPrevious() {
    setBusy(true);
    setError(null);
    try {
      await dispatch("copy_previous_month", { month: month() }).promise;
      emitMoneyDataChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not copy last month");
    } finally {
      setBusy(false);
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
            class="btn btn-secondary"
            onClick={() => setMoving(true)}
            disabled={!categories().length || dataResult.loading || busy()}
          >
            <MoneyIcon name="move" />
            Move money
          </button>
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
          <div
            class="plan-to-assign"
            classList={{ "is-negative": (data()?.budget.toBudget ?? 0) < 0 }}
          >
            <span class="metric-label">
              {(data()?.budget.toBudget ?? 0) < 0 ? "Overassigned" : "To assign"}
            </span>
            <strong class={privacy().blurClass()}>
              {fmt().formatCents(Math.abs(data()?.budget.toBudget ?? 0))}
            </strong>
            <Show when={(data()?.budget.toBudget ?? 0) === 0}>
              <span class="assigned-check">
                <MoneyIcon name="check" size={15} />
                All assigned
              </span>
            </Show>
          </div>
          <div>
            <span class="metric-label">Assigned</span>
            <strong class={privacy().blurClass()}>{fmt().formatCents(totalAssigned())}</strong>
          </div>
          <div>
            <span class="metric-label">Spent</span>
            <strong class={privacy().blurClass()}>{fmt().formatCents(totalSpent())}</strong>
          </div>
          <div>
            <span class="metric-label">Available</span>
            <strong class={privacy().blurClass()}>{fmt().formatCents(totalAvailable())}</strong>
          </div>
        </div>
        <div class="plan-tools">
          <div class="filter-chips">
            <button classList={{ active: filter() === "all" }} onClick={() => setFilter("all")}>
              All
            </button>
            <button
              classList={{ active: filter() === "overspent" }}
              onClick={() => setFilter("overspent")}
            >
              Overspent <span>{overspent().length}</span>
            </button>
            <button
              classList={{ active: filter() === "target" }}
              onClick={() => setFilter("target")}
            >
              Under target <span>{underTarget().length}</span>
            </button>
          </div>
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
                  onClick={() => {
                    void copyPrevious();
                  }}
                  disabled={busy()}
                >
                  Fill from last month
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
              <h2>Start with a category.</h2>
              <button class="btn btn-primary" onClick={() => setNewCategory(true)}>
                <MoneyIcon name="plus" />
                Add category
              </button>
            </div>
          }
        >
          <Show
            when={visible().length}
            fallback={
              <p class="quiet-empty">
                {filter() === "overspent"
                  ? "No overspending"
                  : filter() === "target"
                    ? "No targets need funding"
                    : "No matching categories"}
              </p>
            }
          >
            <div class="plan-table">
              <div class="plan-table-header">
                <span>Category</span>
                <span>Assigned</span>
                <span>Spent</span>
                <span>Available</span>
              </div>
              <For each={grouped()}>
                {(group) => (
                  <section class="plan-group">
                    <div class="plan-group-heading">
                      <h3>{group.name}</h3>
                      <strong class={privacy().blurClass()}>
                        {fmt().formatCents(
                          group.rows.reduce((sum, category) => sum + category.leftover, 0),
                        )}
                      </strong>
                    </div>
                    <For each={group.rows}>
                      {(category) => (
                        <div class="plan-row">
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
                            <Show when={targetFor(category)}>
                              {(target) => (
                                <span class="target-line">
                                  <span class="target-track">
                                    <span
                                      style={{
                                        width: `${Math.min(100, Math.max(0, (category.budgeted / target()) * 100))}%`,
                                      }}
                                    />
                                  </span>
                                  <Show
                                    when={category.budgeted < target()}
                                    fallback={<MoneyIcon name="check" size={12} />}
                                  >
                                    <small class={privacy().blurClass()}>
                                      {fmt().formatCents(Math.max(0, target() - category.budgeted))}{" "}
                                      to target
                                    </small>
                                  </Show>
                                </span>
                              )}
                            </Show>
                          </button>
                          <label class="plan-assigned">
                            <span class="mobile-column-label">Assigned</span>
                            <input
                              aria-label={`Assigned to ${category.categoryName}`}
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
                          <span class={`plan-spent ${privacy().blurClass()}`}>
                            <span class="mobile-column-label">Spent</span>
                            {fmt().formatCents(Math.max(0, -category.spent))}
                          </span>
                          <button
                            class={`plan-available ${privacy().blurClass()}`}
                            classList={{
                              "is-overspent": category.leftover < 0,
                              "is-empty": category.leftover === 0,
                            }}
                            aria-label={`${category.categoryName} available: ${fmt().formatCents(category.leftover)}`}
                            onClick={() => setParams({ category: category.categoryId })}
                          >
                            <span class="mobile-column-label">Available</span>
                            {fmt().formatCents(category.leftover)}
                          </button>
                        </div>
                      )}
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
                <strong class={privacy().blurClass()}>
                  {fmt().formatCents(
                    visible().reduce((sum, category) => sum + Math.max(0, -category.spent), 0),
                  )}
                </strong>
                <strong class={privacy().blurClass()}>
                  {fmt().formatCents(
                    visible().reduce((sum, category) => sum + category.leftover, 0),
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
