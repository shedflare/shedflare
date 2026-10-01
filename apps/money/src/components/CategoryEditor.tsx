import { createSignal, For, Show } from "solid-js";
import * as Schema from "effect/Schema";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { readGoal, GoalSchema, type CategoryDefinition } from "../lib/budget-view";
import type { CategoryGroupsResponse } from "../domain/schemas-client";
import type { CategoryIcon } from "../domain/category-icons";
import MoneyDialog from "./MoneyDialog";
import CategoryIconPicker from "./CategoryIconPicker";

type GoalType = Schema.Schema.Type<typeof GoalSchema>["type"] | "none";
const GoalTypeSchema = Schema.Literals([
  "none",
  "monthly",
  "byDate",
  "refill",
  "periodic",
  "percentage",
]);
export default function CategoryEditor(props: {
  category?: CategoryDefinition;
  groups: CategoryGroupsResponse["groups"];
  initialGroupId?: string;
  onClose: () => void;
}) {
  const fmt = useCurrency();
  const original = props.category;
  const goal = readGoal(original?.goalDef);
  const [name, setName] = createSignal(original?.name ?? "");
  const [icon, setIcon] = createSignal<CategoryIcon | null>(original?.icon ?? null);
  const [groupId, setGroupId] = createSignal(original?.groupId ?? props.initialGroupId ?? "");
  const [isIncome, setIsIncome] = createSignal(
    original?.isIncome ??
      props.groups.find((row) => row.id === props.initialGroupId)?.isIncome ??
      false,
  );
  const [goalType, setGoalType] = createSignal<GoalType>(goal?.type ?? "none");
  const [amount, setAmount] = createSignal(goal?.amount ? fmt().formatCentsInput(goal.amount) : "");
  const [date, setDate] = createSignal(goal?.targetDate ?? "");
  const [frequency, setFrequency] = createSignal(goal?.frequency ?? "quarterly");
  const [percentage, setPercentage] = createSignal(String(goal?.percentage ?? ""));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    if (!name().trim()) {
      setError("Enter a category name.");
      return;
    }
    if (
      goalType() !== "none" &&
      goalType() !== "percentage" &&
      (!Number.isSafeInteger(fmt().parseInput(amount())) || fmt().parseInput(amount()) <= 0)
    ) {
      setError("Enter a target greater than zero.");
      return;
    }
    if (
      goalType() === "percentage" &&
      (!Number.isFinite(Number(percentage())) ||
        Number(percentage()) <= 0 ||
        Number(percentage()) > 100)
    ) {
      setError("Enter a percentage between 0 and 100.");
      return;
    }
    const goalDef =
      goalType() === "none"
        ? null
        : JSON.stringify({
            type: goalType(),
            amount: goalType() === "percentage" ? undefined : fmt().parseInput(amount()),
            targetDate: date() || undefined,
            frequency: goalType() === "periodic" ? frequency() : undefined,
            percentage: goalType() === "percentage" ? Number(percentage()) : undefined,
          });
    setBusy(true);
    setError(null);
    try {
      if (original)
        await dispatch(
          "update_category",
          {
            id: original.id,
            name: name().trim(),
            icon: icon(),
            groupId: groupId() || null,
            goalDef,
          },
          {
            undoInfo: {
              label: "Edit category",
              inverse: {
                commandType: "update_category",
                payload: {
                  id: original.id,
                  name: original.name,
                  icon: original.icon,
                  groupId: original.groupId,
                  goalDef: original.goalDef,
                },
              },
            },
          },
        ).promise;
      else {
        // Creation has no target yet: the target controls are only shown for existing categories.
        await dispatch(
          "create_category",
          { name: name().trim(), icon: icon(), groupId: groupId() || null, isIncome: isIncome() },
          {
            undoInfo: {
              label: "Add category",
              inverse: (data) => ({
                commandType: "delete_category",
                payload: { id: requireCommandId(data) },
              }),
            },
          },
        ).promise;
      }
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save category");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog
      title={original ? "Edit category" : "Add category"}
      drawer
      busy={busy()}
      onClose={props.onClose}
    >
      <form class="money-form" onSubmit={save}>
        <CategoryIconPicker name={name()} value={icon()} onChange={setIcon} disabled={busy()} />
        <div class="form-group">
          <label for="edit-category-name">Name</label>
          <input
            id="edit-category-name"
            value={name()}
            required
            disabled={busy()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <Show when={!original}>
          <div class="form-group">
            <label for="edit-category-type">Type</label>
            <select
              id="edit-category-type"
              value={isIncome() ? "income" : "expense"}
              disabled={busy()}
              onChange={(event) => {
                setIsIncome(event.currentTarget.value === "income");
                setGroupId("");
              }}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </div>
        </Show>
        <div class="form-group">
          <label for="edit-category-group">Group</label>
          <select
            id="edit-category-group"
            value={groupId()}
            disabled={busy()}
            onChange={(event) => setGroupId(event.currentTarget.value)}
          >
            <option value="">{isIncome() ? "Income" : "Other"}</option>
            <For
              each={props.groups.filter(
                (row) => row.id === groupId() || (!row.hidden && row.isIncome === isIncome()),
              )}
            >
              {(row) => <option value={row.id}>{row.name}</option>}
            </For>
          </select>
        </div>
        <Show when={original && !isIncome()}>
          <details class="form-disclosure">
            <summary>Target</summary>
            <div class="form-group">
              <label for="edit-category-target">Target</label>
              <select
                id="edit-category-target"
                value={goalType()}
                disabled={busy()}
                onChange={(event) =>
                  setGoalType(Schema.decodeUnknownSync(GoalTypeSchema)(event.currentTarget.value))
                }
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
                <label for="edit-target-amount">Amount</label>
                <input
                  id="edit-target-amount"
                  inputmode={fmt().inputMode}
                  value={amount()}
                  required
                  disabled={busy()}
                  onInput={(event) => setAmount(event.currentTarget.value)}
                />
              </div>
            </Show>
            <Show when={goalType() === "byDate" || goalType() === "refill"}>
              <div class="form-group">
                <label for="edit-target-date">By month</label>
                <input
                  id="edit-target-date"
                  type="month"
                  value={date()}
                  required={goalType() === "byDate"}
                  disabled={busy()}
                  onInput={(event) => setDate(event.currentTarget.value)}
                />
              </div>
            </Show>
            <Show when={goalType() === "periodic"}>
              <div class="form-group">
                <label for="edit-target-frequency">Repeat</label>
                <select
                  id="edit-target-frequency"
                  value={frequency()}
                  disabled={busy()}
                  onChange={(event) => setFrequency(event.currentTarget.value)}
                >
                  <option value="quarterly">Every 3 months</option>
                  <option value="biannual">Every 6 months</option>
                  <option value="yearly">Every year</option>
                </select>
              </div>
            </Show>
            <Show when={goalType() === "percentage"}>
              <div class="form-group">
                <label for="edit-target-percent">Percent</label>
                <input
                  id="edit-target-percent"
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={percentage()}
                  required
                  disabled={busy()}
                  onInput={(event) => setPercentage(event.currentTarget.value)}
                />
              </div>
            </Show>
          </details>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <button type="submit" class="btn btn-primary btn-full" disabled={busy()}>
          {busy() ? "Saving…" : original ? "Save category" : "Add category"}
        </button>
      </form>
    </MoneyDialog>
  );
}
