import { createMemo, createSignal, For, Show } from "solid-js";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import CategoryBadge from "./CategoryBadge";
import { dispatch } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";
import type { CategoryDefinition } from "../lib/budget-view";
import { monthlyPlan } from "../lib/monthly-plan";
import type { MonthBudget } from "../domain/schemas-client";

export default function MonthlyPlanDialog(props: {
  month: string;
  budget: MonthBudget;
  definitions: readonly CategoryDefinition[];
  onClose: () => void;
}) {
  const budget = props.budget;
  const month = props.month;
  const rows = monthlyPlan(budget.categories, props.definitions, [], "targets");
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const [excluded, setExcluded] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const selected = createMemo(() =>
    rows.filter((row) => !excluded().includes(row.category.categoryId)),
  );
  const total = createMemo(() => selected().reduce((sum, row) => sum + row.amount, 0));
  const remaining = createMemo(() => budget.toBudget - total());
  async function save() {
    if (!selected().length || busy()) return;
    setBusy(true);
    setError(null);
    const allocations = selected().map((row) => ({
      categoryId: row.category.categoryId,
      amount: row.amount,
    }));
    try {
      await dispatch(
        "allocate_budget",
        { month, allocations },
        {
          undoInfo: {
            label: "Monthly targets funded",
            inverse: {
              commandType: "allocate_budget",
              payload: {
                month,
                allocations: allocations.map((row) => ({ ...row, amount: -row.amount })),
              },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not fund targets");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog title="Fund targets" drawer onClose={props.onClose} busy={busy()}>
      <div class="monthly-plan-body">
        <p class="sheet-eyebrow">{df().formatMonth(month)}</p>
        <Show
          when={rows.length}
          fallback={
            <div class="plan-complete">
              <MoneyIcon name="check" size={26} />
              <strong>Targets are covered</strong>
              <span>Set monthly targets in a category.</span>
            </div>
          }
        >
          <div class="plan-selection-header">
            <span>
              {selected().length} of {rows.length} categories
            </span>
            <button
              class="text-button"
              disabled={busy()}
              onClick={() =>
                setExcluded(
                  selected().length === rows.length
                    ? rows.map((row) => row.category.categoryId)
                    : [],
                )
              }
            >
              {selected().length === rows.length ? "Clear selection" : "Select all"}
            </button>
          </div>
          <div class="plan-selection-list">
            <For each={rows}>
              {(row) => (
                <label class="plan-selection-row">
                  <input
                    type="checkbox"
                    disabled={busy()}
                    checked={!excluded().includes(row.category.categoryId)}
                    onChange={(event) =>
                      setExcluded((ids) =>
                        event.currentTarget.checked
                          ? ids.filter((id) => id !== row.category.categoryId)
                          : [...ids, row.category.categoryId],
                      )
                    }
                  />
                  <CategoryBadge name={row.category.categoryName} icon={row.icon} small />
                  <span class="plan-selection-name">
                    <strong>{row.category.categoryName}</strong>
                    <small class={privacy().blurClass()}>
                      {fmt().formatCents(row.category.budgeted)} → {fmt().formatCents(row.target)}
                    </small>
                  </span>
                  <strong class={`plan-selection-amount ${privacy().blurClass()}`}>
                    +{fmt().formatCents(row.amount)}
                  </strong>
                </label>
              )}
            </For>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={selected().length}>
          <div class="plan-sheet-footer">
            <Show when={remaining() < 0}>
              <p class={`plan-shortfall ${privacy().blurClass()}`}>
                Overassigned by {fmt().formatCents(Math.abs(remaining()))}
              </p>
            </Show>
            <button class="btn btn-primary btn-full" disabled={busy()} onClick={() => void save()}>
              {busy() ? "Saving…" : `Fund ${fmt().formatCents(total())}`}
            </button>
          </div>
        </Show>
      </div>
    </MoneyDialog>
  );
}
