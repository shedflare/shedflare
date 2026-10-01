import { createMemo, createSignal, For, Show } from "solid-js";
import type { BudgetCategory } from "../lib/budget-view";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { dispatch } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";

export default function MoveMoneyDialog(props: {
  month: string;
  categories: readonly BudgetCategory[];
  targetId?: string;
  onClose: () => void;
}) {
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal(props.targetId ?? "");
  const target = props.categories.find((category) => category.categoryId === props.targetId);
  const [amount, setAmount] = createSignal(
    target && target.leftover < 0 ? fmt().formatCentsInput(-target.leftover) : "",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const source = createMemo(() =>
    props.categories.find((category) => category.categoryId === from()),
  );
  const destination = createMemo(() =>
    props.categories.find((category) => category.categoryId === to()),
  );
  const cents = createMemo(() => fmt().parseInput(amount()));
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const value = cents();
    if (
      !source() ||
      !destination() ||
      from() === to() ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      setError("Choose two categories and an amount.");
      return;
    }
    if (value > (source()?.leftover ?? 0)) {
      setError("That category doesn’t have enough available.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "transfer_budget",
        { month: props.month, from: from(), to: to(), amount: value },
        {
          undoInfo: {
            label: "Move money",
            inverse: {
              commandType: "transfer_budget",
              payload: { month: props.month, from: to(), to: from(), amount: value },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not move money");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog
      title={target && target.leftover < 0 ? "Cover overspending" : "Move money"}
      onClose={props.onClose}
      busy={busy()}
    >
      <form onSubmit={save} class="money-form">
        <div class="form-group">
          <label for="move-from">From</label>
          <select
            id="move-from"
            required
            autofocus
            value={from()}
            onChange={(event) => setFrom(event.currentTarget.value)}
            disabled={busy()}
          >
            <option value="">Choose category</option>
            <For
              each={props.categories.filter(
                (category) => category.categoryId !== to() && category.leftover > 0,
              )}
            >
              {(category) => (
                <option value={category.categoryId}>
                  {category.categoryName} · {fmt().formatCents(category.leftover)}
                </option>
              )}
            </For>
          </select>
        </div>
        <div class="move-direction">
          <MoneyIcon name="move" />
        </div>
        <div class="form-group">
          <label for="move-to">To</label>
          <select
            id="move-to"
            required
            value={to()}
            onChange={(event) => setTo(event.currentTarget.value)}
            disabled={busy()}
          >
            <option value="">Choose category</option>
            <For each={props.categories.filter((category) => category.categoryId !== from())}>
              {(category) => <option value={category.categoryId}>{category.categoryName}</option>}
            </For>
          </select>
        </div>
        <div class="form-group">
          <label for="move-amount">Amount</label>
          <input
            id="move-amount"
            type="text"
            inputmode={fmt().inputMode}
            required
            value={amount()}
            onInput={(event) => setAmount(event.currentTarget.value)}
            disabled={busy()}
          />
        </div>
        <Show when={source() && destination() && cents() > 0}>
          <div class={`move-preview ${privacy().blurClass()}`}>
            <span>
              {source()?.categoryName}
              <strong>{fmt().formatCents((source()?.leftover ?? 0) - cents())}</strong>
            </span>
            <MoneyIcon name="arrow" />
            <span>
              {destination()?.categoryName}
              <strong>{fmt().formatCents((destination()?.leftover ?? 0) + cents())}</strong>
            </span>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <button class="btn btn-primary btn-full" type="submit" disabled={busy()}>
          {busy() ? "Moving…" : "Move money"}
        </button>
      </form>
    </MoneyDialog>
  );
}
