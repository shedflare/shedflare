import { createSignal, For, Show } from "solid-js";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import { useCurrency } from "../lib/currency";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { formatCalendarDate, parseCalendarDate } from "../domain/types";
import type { AccountsResponse } from "../domain/schemas-client";

export default function AccountTransferDialog(props: {
  accounts: AccountsResponse["accounts"];
  fromAccountId: string;
  onClose: () => void;
}) {
  const fmt = useCurrency();
  const [from, setFrom] = createSignal(props.fromAccountId);
  const [to, setTo] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [date, setDate] = createSignal(formatCalendarDate(new Date()));
  const [notes, setNotes] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    const value = fmt().parseInput(amount());
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      !parseCalendarDate(date()) ||
      !to() ||
      from() === to()
    ) {
      setError("Choose two accounts, a valid date, and a positive amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "create_account_transfer",
        {
          fromAccountId: from(),
          toAccountId: to(),
          amount: value,
          date: date(),
          notes: notes() || null,
        },
        {
          undoInfo: {
            label: "Account transfer",
            inverse: (data) => ({
              commandType: "delete_account_transfer",
              payload: { id: requireCommandId(data) },
            }),
          },
        },
      ).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not transfer money");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog title="Transfer" drawer busy={busy()} onClose={props.onClose}>
      <form class="money-form" onSubmit={save}>
        <div class="composer-amount">
          <span>{fmt().symbol}</span>
          <input
            aria-label="Transfer amount"
            type="text"
            inputmode={fmt().inputMode}
            value={amount()}
            onInput={(event) => setAmount(event.currentTarget.value)}
            placeholder={fmt().code === "IDR" ? "0" : "0.00"}
            autofocus
            disabled={busy()}
          />
        </div>
        <div class="form-group">
          <label for="transfer-from">From</label>
          <select
            id="transfer-from"
            value={from()}
            disabled={busy()}
            onChange={(event) => {
              setFrom(event.currentTarget.value);
              if (to() === event.currentTarget.value) setTo("");
            }}
          >
            <For each={props.accounts.filter((row) => !row.closed)}>
              {(account) => <option value={account.id}>{account.name}</option>}
            </For>
          </select>
        </div>
        <div class="form-group">
          <label for="transfer-to">To</label>
          <select
            id="transfer-to"
            value={to()}
            disabled={busy()}
            required
            onChange={(event) => setTo(event.currentTarget.value)}
          >
            <option value="">Choose account</option>
            <For each={props.accounts.filter((row) => !row.closed && row.id !== from())}>
              {(account) => <option value={account.id}>{account.name}</option>}
            </For>
          </select>
        </div>
        <details class="composer-details">
          <summary>
            <MoneyIcon name="more" size={16} />
            Details
          </summary>
          <div class="form-group">
            <label for="transfer-date">Date</label>
            <input
              id="transfer-date"
              type="date"
              value={date()}
              disabled={busy()}
              onInput={(event) => setDate(event.currentTarget.value)}
            />
          </div>
          <div class="form-group">
            <label for="transfer-notes">Note</label>
            <input
              id="transfer-notes"
              value={notes()}
              disabled={busy()}
              onInput={(event) => setNotes(event.currentTarget.value)}
            />
          </div>
        </details>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <button class="btn btn-primary btn-full" disabled={busy()} type="submit">
          {busy() ? "Transferring…" : "Transfer"}
        </button>
      </form>
    </MoneyDialog>
  );
}
