import { createSignal, For, Show } from "solid-js";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import { useCurrency } from "../lib/currency";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { formatCalendarDate, parseCalendarDate } from "../domain/types";
import { FREQUENCIES, recurrenceConfig, type RecurringPayment } from "../lib/recurring-view";
import type {
  AccountsResponse,
  CategoriesResponse,
  DiscoveredSchedule,
} from "../domain/schemas-client";

export default function RecurringPaymentForm(props: {
  payment?: RecurringPayment;
  candidate?: DiscoveredSchedule;
  accounts: AccountsResponse["accounts"];
  categories: CategoriesResponse["categories"];
  onClose: () => void;
}) {
  const original = props.payment;
  const candidate = props.candidate;
  const fmt = useCurrency();
  const config = recurrenceConfig(
    original?.recurrenceRules ?? JSON.stringify({ type: candidate?.recurrenceType ?? "monthly" }),
  );
  const initialAmount = original?.amount ?? candidate?.amount;
  const [name, setName] = createSignal(original?.name ?? candidate?.payee ?? "");
  const [amount, setAmount] = createSignal(
    initialAmount == null ? "" : fmt().formatCentsInput(Math.abs(initialAmount)),
  );
  const [income, setIncome] = createSignal(initialAmount != null && initialAmount > 0);
  const [accountId, setAccountId] = createSignal(
    original?.accountId ??
      candidate?.accountId ??
      props.accounts.find((row) => !row.closed)?.id ??
      "",
  );
  const [categoryId, setCategoryId] = createSignal(
    original?.categoryId ?? candidate?.categoryId ?? "",
  );
  const [date, setDate] = createSignal(
    original?.nextDate ?? original?.startDate ?? formatCalendarDate(new Date()),
  );
  const [frequency, setFrequency] = createSignal(config.type);
  const [weekend, setWeekend] = createSignal(
    config.skipWeekend ? (config.weekendSolveMode ?? "after") : "none",
  );
  const [endMode, setEndMode] = createSignal(
    config.endMode === "after_n_occurrences" ? "after_n" : (config.endMode ?? "never"),
  );
  const [endCount, setEndCount] = createSignal(String(config.endOccurrences ?? 12));
  const [endDate, setEndDate] = createSignal(config.endDate ?? date());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    const parsed = amount().trim() ? fmt().parseInput(amount()) : null;
    const count = Number(endCount());
    if (
      !name().trim() ||
      !accountId() ||
      !parseCalendarDate(date()) ||
      (parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 0)) ||
      (endMode() === "after_n" && (!Number.isSafeInteger(count) || count < 1)) ||
      (endMode() === "on_date" && (!parseCalendarDate(endDate()) || endDate() < date()))
    ) {
      setError("Check the name, account, amount, and dates.");
      return;
    }
    const fields = {
      name: name().trim(),
      accountId: accountId(),
      categoryId: categoryId() || null,
      amount: parsed === null ? null : income() ? parsed : -parsed,
      nextDate: date(),
      startDate: original?.startDate ?? date(),
      recurrenceRules: JSON.stringify({
        ...config,
        type: frequency(),
        skipWeekend: weekend() !== "none",
        weekendSolveMode: weekend() === "before" ? "before" : "after",
        endMode: endMode(),
        endOccurrences: endMode() === "after_n" ? count : undefined,
        endDate: endMode() === "on_date" ? endDate() : undefined,
      }),
    };
    setBusy(true);
    setError(null);
    try {
      if (original) {
        await dispatch(
          "update_schedule",
          { id: original.id, fields },
          {
            undoInfo: {
              label: "Recurring payment updated",
              inverse: {
                commandType: "update_schedule",
                payload: {
                  id: original.id,
                  fields: {
                    name: original.name,
                    accountId: original.accountId,
                    categoryId: original.categoryId,
                    amount: original.amount,
                    nextDate: original.nextDate,
                    startDate: original.startDate,
                    recurrenceRules: original.recurrenceRules,
                  },
                },
              },
            },
          },
        ).promise;
      } else {
        await dispatch(
          "create_schedule",
          { schedule: fields },
          {
            undoInfo: {
              label: "Recurring payment created",
              inverse: (data) => ({
                commandType: "delete_schedule",
                payload: { id: requireCommandId(data) },
              }),
            },
          },
        ).promise;
      }
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save payment");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog
      title={original ? "Edit payment" : "New payment"}
      drawer
      busy={busy()}
      onClose={props.onClose}
    >
      <form class="money-form recurring-form" onSubmit={save}>
        <div class="composer-kind" role="group" aria-label="Payment type">
          <button
            type="button"
            classList={{ active: !income() }}
            disabled={busy()}
            onClick={() => setIncome(false)}
          >
            Expense
          </button>
          <button
            type="button"
            classList={{ active: income() }}
            disabled={busy()}
            onClick={() => setIncome(true)}
          >
            Income
          </button>
        </div>
        <div class="composer-amount">
          <span>{fmt().symbol}</span>
          <input
            aria-label="Payment amount"
            type="text"
            inputmode={fmt().inputMode}
            value={amount()}
            placeholder={fmt().code === "IDR" ? "0" : "0.00"}
            disabled={busy()}
            onInput={(event) => setAmount(event.currentTarget.value)}
          />
        </div>
        <div class="form-group">
          <label for="payment-name">Name</label>
          <input
            id="payment-name"
            value={name()}
            required
            autofocus
            disabled={busy()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="payment-date">Next payment</label>
            <input
              id="payment-date"
              type="date"
              value={date()}
              required
              disabled={busy()}
              onInput={(event) => setDate(event.currentTarget.value)}
            />
          </div>
          <div class="form-group">
            <label for="payment-frequency">Repeats</label>
            <select
              id="payment-frequency"
              value={frequency()}
              disabled={busy()}
              onChange={(event) => setFrequency(event.currentTarget.value)}
            >
              <For each={FREQUENCIES}>
                {(row) => <option value={row.value}>{row.label}</option>}
              </For>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label for="payment-account">Account</label>
          <select
            id="payment-account"
            value={accountId()}
            required
            disabled={busy()}
            onChange={(event) => setAccountId(event.currentTarget.value)}
          >
            <option value="">Choose account</option>
            <For
              each={props.accounts.filter((row) => !row.closed || row.id === original?.accountId)}
            >
              {(row) => (
                <option value={row.id}>
                  {row.name}
                  {row.closed ? " (closed)" : ""}
                </option>
              )}
            </For>
          </select>
        </div>
        <div class="form-group">
          <label for="payment-category">Category</label>
          <select
            id="payment-category"
            value={categoryId()}
            disabled={busy()}
            onChange={(event) => setCategoryId(event.currentTarget.value)}
          >
            <option value="">Uncategorized</option>
            <For
              each={props.categories.filter(
                (row) => !row.hidden || row.id === original?.categoryId,
              )}
            >
              {(row) => <option value={row.id}>{row.name}</option>}
            </For>
          </select>
        </div>
        <details class="composer-details">
          <summary>
            <MoneyIcon name="more" size={16} />
            Details
          </summary>
          <div class="form-group">
            <label for="payment-weekend">Weekends</label>
            <select
              id="payment-weekend"
              value={weekend()}
              disabled={busy()}
              onChange={(event) => setWeekend(event.currentTarget.value)}
            >
              <option value="none">Keep the date</option>
              <option value="before">Move to Friday</option>
              <option value="after">Move to Monday</option>
            </select>
          </div>
          <div class="form-group">
            <label for="payment-end">Ends</label>
            <select
              id="payment-end"
              value={endMode()}
              disabled={busy()}
              onChange={(event) => setEndMode(event.currentTarget.value)}
            >
              <option value="never">Never</option>
              <option value="after_n">After a number of payments</option>
              <option value="on_date">On a date</option>
            </select>
          </div>
          <Show when={endMode() === "after_n"}>
            <div class="form-group">
              <label for="payment-count">Payments remaining</label>
              <input
                id="payment-count"
                type="number"
                min="1"
                step="1"
                value={endCount()}
                disabled={busy()}
                onInput={(event) => setEndCount(event.currentTarget.value)}
              />
            </div>
          </Show>
          <Show when={endMode() === "on_date"}>
            <div class="form-group">
              <label for="payment-end-date">End date</label>
              <input
                id="payment-end-date"
                type="date"
                min={date()}
                value={endDate()}
                disabled={busy()}
                onInput={(event) => setEndDate(event.currentTarget.value)}
              />
            </div>
          </Show>
        </details>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <button class="btn btn-primary btn-full" type="submit" disabled={busy()}>
          {busy() ? "Saving…" : "Save payment"}
        </button>
      </form>
    </MoneyDialog>
  );
}
