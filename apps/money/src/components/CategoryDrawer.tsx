import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import * as Schema from "effect/Schema";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import { dispatch } from "../lib/pending-ops";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import {
  availableRatio,
  readGoal,
  type BudgetCategory,
  type CategoryDefinition,
} from "../lib/budget-view";
import { monthBoundaries, toMonthInt } from "../domain/types";
import { useMoneyShell } from "./MoneyShellContext";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import MoveMoneyDialog from "./MoveMoneyDialog";
import CategoryBadge from "./CategoryBadge";
import CategoryIconPicker from "./CategoryIconPicker";
import type { CategoryIcon } from "../domain/category-icons";

const GoalTypeSchema = Schema.Literals([
  "none",
  "monthly",
  "byDate",
  "refill",
  "periodic",
  "percentage",
]);
type GoalType = Schema.Schema.Type<typeof GoalTypeSchema>;

export default function CategoryDrawer(props: {
  month: string;
  category: BudgetCategory;
  definition?: CategoryDefinition;
  categories: readonly BudgetCategory[];
  onClose: () => void;
}) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const shell = useMoneyShell();
  const navigate = useNavigate();
  const [editing, setEditing] = createSignal(false);
  const [moving, setMoving] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [assigned, setAssigned] = createSignal(fmt().formatCentsInput(props.category.budgeted));
  const [name, setName] = createSignal(props.category.categoryName);
  const [icon, setIcon] = createSignal<CategoryIcon | null>(props.definition?.icon ?? null);
  const goal = readGoal(props.definition?.goalDef);
  const [goalType, setGoalType] = createSignal<GoalType>(goal?.type ?? "none");
  const [goalAmount, setGoalAmount] = createSignal(
    goal?.amount ? fmt().formatCentsInput(goal.amount) : "",
  );
  const [goalDate, setGoalDate] = createSignal(goal?.targetDate ?? "");
  const [frequency, setFrequency] = createSignal(goal?.frequency ?? "quarterly");
  const [percentage, setPercentage] = createSignal(String(goal?.percentage ?? ""));
  const [activityResult, { refetch }] = createResource(
    () => ({ id: props.category.categoryId, month: props.month }),
    ({ id, month }) =>
      loadRequest(async () => {
        const { start, end } = monthBoundaries(month);
        return api.transactions({
          conditions: [
            { field: "category", op: "is", value: id },
            { field: "date", op: "gte", value: start },
            { field: "date", op: "lte", value: end },
          ],
        });
      }),
  );
  const activity = () => requestValue(activityResult());
  onMount(() =>
    onCleanup(
      listenForMoneyDataChanged(() => {
        void refetch();
      }),
    ),
  );
  const recent = createMemo(() =>
    (activity()?.transactions ?? []).filter((transaction) => !transaction.isParent).slice(0, 8),
  );
  async function saveAssigned(event: SubmitEvent) {
    event.preventDefault();
    const amount = fmt().parseInput(assigned());
    if (!Number.isSafeInteger(amount)) {
      setError("Enter a valid amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "set_budget_amount",
        { month: toMonthInt(props.month), categoryId: props.category.categoryId, amount },
        {
          undoInfo: {
            label: "Assign money",
            inverse: {
              commandType: "set_budget_amount",
              payload: {
                month: toMonthInt(props.month),
                categoryId: props.category.categoryId,
                amount: props.category.budgeted,
              },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not assign money");
    } finally {
      setBusy(false);
    }
  }
  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    if (
      goalType() !== "none" &&
      goalType() !== "percentage" &&
      (!Number.isSafeInteger(fmt().parseInput(goalAmount())) || fmt().parseInput(goalAmount()) <= 0)
    ) {
      setError("Enter a target greater than zero.");
      return;
    }
    setBusy(true);
    setError(null);
    const type = goalType();
    const goalDef =
      type === "none"
        ? null
        : JSON.stringify({
            type,
            amount: type === "percentage" ? undefined : fmt().parseInput(goalAmount()),
            targetDate: goalDate() || undefined,
            frequency: type === "periodic" ? frequency() : undefined,
            percentage: type === "percentage" ? Number(percentage()) : undefined,
          });
    try {
      await dispatch(
        "update_category",
        { id: props.category.categoryId, name: name().trim(), goalDef, icon: icon() },
        {
          undoInfo: {
            label: "Update category",
            inverse: {
              commandType: "update_category",
              payload: {
                id: props.category.categoryId,
                name: props.category.categoryName,
                goalDef: props.definition?.goalDef ?? null,
                icon: props.definition?.icon ?? null,
              },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save category");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <MoneyDialog title={props.category.categoryName} drawer onClose={props.onClose} busy={busy()}>
        <div class="category-sheet-body">
          <div class="category-sheet-top">
            <CategoryBadge name={props.category.categoryName} icon={props.definition?.icon} />
            <span class="text-muted">{props.category.groupName ?? "Other"}</span>
            <button
              type="button"
              class="btn btn-icon btn-ghost"
              aria-label="Category settings"
              onClick={() => {
                setError(null);
                setEditing(!editing());
              }}
              disabled={busy()}
            >
              <MoneyIcon name="settings" />
            </button>
          </div>
          <Show
            when={!editing()}
            fallback={
              <form class="money-form" onSubmit={saveSettings}>
                <CategoryIconPicker
                  name={name()}
                  value={icon()}
                  onChange={setIcon}
                  disabled={busy()}
                />
                <div class="form-group">
                  <label for="category-name">Name</label>
                  <input
                    id="category-name"
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value)}
                    required
                    disabled={busy()}
                  />
                </div>
                <div class="form-group">
                  <label for="category-goal">Target</label>
                  <select
                    id="category-goal"
                    value={goalType()}
                    onChange={(event) =>
                      setGoalType(
                        Schema.decodeUnknownSync(GoalTypeSchema)(event.currentTarget.value),
                      )
                    }
                    disabled={busy()}
                  >
                    <option value="none">No target</option>
                    <option value="monthly">Monthly amount</option>
                    <option value="byDate">Save by a date</option>
                    <option value="refill">Refill a balance</option>
                    <option value="periodic">Every few months</option>
                    <option value="percentage">Percent of income</option>
                  </select>
                </div>
                <Show when={goalType() !== "none" && goalType() !== "percentage"}>
                  <div class="form-group">
                    <label for="goal-amount">Amount</label>
                    <input
                      id="goal-amount"
                      type="text"
                      inputmode={fmt().inputMode}
                      required
                      value={goalAmount()}
                      onInput={(event) => setGoalAmount(event.currentTarget.value)}
                      disabled={busy()}
                    />
                  </div>
                </Show>
                <Show when={goalType() === "byDate" || goalType() === "refill"}>
                  <div class="form-group">
                    <label for="goal-date">By month</label>
                    <input
                      id="goal-date"
                      type="month"
                      value={goalDate()}
                      onInput={(event) => setGoalDate(event.currentTarget.value)}
                      required={goalType() === "byDate"}
                      disabled={busy()}
                    />
                  </div>
                </Show>
                <Show when={goalType() === "periodic"}>
                  <div class="form-group">
                    <label for="goal-frequency">Repeat</label>
                    <select
                      id="goal-frequency"
                      value={frequency()}
                      onChange={(event) => setFrequency(event.currentTarget.value)}
                      disabled={busy()}
                    >
                      <option value="quarterly">Every 3 months</option>
                      <option value="biannual">Every 6 months</option>
                      <option value="yearly">Every year</option>
                    </select>
                  </div>
                </Show>
                <Show when={goalType() === "percentage"}>
                  <div class="form-group">
                    <label for="goal-percent">Percent</label>
                    <input
                      id="goal-percent"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      required
                      value={percentage()}
                      onInput={(event) => setPercentage(event.currentTarget.value)}
                      disabled={busy()}
                    />
                  </div>
                </Show>
                <button type="submit" class="btn btn-primary btn-full" disabled={busy()}>
                  {busy() ? "Saving…" : "Save category"}
                </button>
              </form>
            }
          >
            <div class="category-balance">
              <span class="metric-label">Available</span>
              <strong
                class={privacy().blurClass()}
                classList={{ negative: props.category.leftover < 0 }}
              >
                {fmt().formatCents(props.category.leftover)}
              </strong>
              <div
                class="envelope-meter"
                classList={{ "is-overspent": props.category.leftover < 0 }}
              >
                <span style={{ width: `${availableRatio(props.category) * 100}%` }} />
              </div>
            </div>
            <div class="category-quick-actions">
              <button
                type="button"
                class="btn btn-primary"
                disabled={busy()}
                onClick={() => {
                  shell.openTransaction({ initialCategoryId: props.category.categoryId });
                  props.onClose();
                }}
              >
                <MoneyIcon name="plus" />
                Expense
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                disabled={busy()}
                onClick={() => setMoving(true)}
              >
                <MoneyIcon name="move" />
                {props.category.leftover < 0 ? "Cover" : "Move money"}
              </button>
            </div>
            <form class="assignment-form" onSubmit={saveAssigned}>
              <label for="category-assigned">
                Assigned in {df().formatMonth(props.month).split(" ")[0]}
              </label>
              <div>
                <input
                  id="category-assigned"
                  type="text"
                  inputmode={fmt().inputMode}
                  value={assigned()}
                  onInput={(event) => setAssigned(event.currentTarget.value)}
                  disabled={busy()}
                />
                <button type="submit" class="btn btn-secondary" disabled={busy()}>
                  {busy() ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
            <div class={`category-facts ${privacy().blurClass()}`}>
              <span>
                Spent<strong>{fmt().formatCents(Math.max(0, -props.category.spent))}</strong>
              </span>
              <span>
                Carried in
                <strong>
                  {fmt().formatCents(
                    props.category.leftover - props.category.budgeted - props.category.spent,
                  )}
                </strong>
              </span>
            </div>
            <div class="section-heading">
              <h3>Activity</h3>
              <button
                type="button"
                class="text-button"
                onClick={() => {
                  props.onClose();
                  navigate(
                    `/?category=${encodeURIComponent(props.category.categoryId)}&month=${props.month}`,
                  );
                }}
              >
                View all <MoneyIcon name="arrow" size={15} />
              </button>
            </div>
            <Show
              when={!activityResult.loading}
              fallback={
                <div class="loading" role="status">
                  Loading…
                </div>
              }
            >
              <Show
                when={!requestError(activityResult())}
                fallback={
                  <button class="btn btn-secondary" onClick={() => refetch()}>
                    Retry activity
                  </button>
                }
              >
                <Show
                  when={recent().length}
                  fallback={<p class="quiet-empty">No activity this month</p>}
                >
                  <div class="daily-activity">
                    <For each={recent()}>
                      {(transaction) => (
                        <button
                          type="button"
                          class="daily-activity-row"
                          onClick={() => {
                            props.onClose();
                            navigate(
                              `/?month=${transaction.date.slice(0, 7)}&focus=${encodeURIComponent(transaction.id)}`,
                            );
                          }}
                        >
                          <span>
                            <strong>
                              {transaction.payee ?? transaction.notes ?? "Transaction"}
                            </strong>
                            <small>{df().formatDate(transaction.date)}</small>
                          </span>
                          <strong class={privacy().blurClass()}>
                            {fmt().formatCents(transaction.amount)}
                          </strong>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
        </div>
      </MoneyDialog>
      <Show when={moving()}>
        <MoveMoneyDialog
          month={props.month}
          categories={props.categories}
          targetId={props.category.categoryId}
          onClose={() => setMoving(false)}
        />
      </Show>
    </>
  );
}
