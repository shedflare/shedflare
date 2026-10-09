import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { emitMoneyDataChanged } from "../lib/data-events";
import { formatCalendarDate } from "../domain/types";
import { formatAmountTyping, NUMBER_FORMAT_SEPS } from "../domain/money-amount";
import { findPayee, matchPayees, type PayeeHistoryEntry } from "../domain/payee-history";
import type { AccountsResponse, CategoriesResponse } from "../domain/schemas-client";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";

type AccountRow = Pick<AccountsResponse["accounts"][number], "id" | "name" | "closed">;
type CategoryRow = Pick<CategoriesResponse["categories"][number], "id" | "name"> & {
  groupName: string | null;
  isIncome?: boolean;
};
interface AddTransactionModalProps {
  accounts: AccountRow[];
  categories: CategoryRow[];
  initialAccountId?: string;
  initialCategoryId?: string;
  onClose: () => void;
  onCreated?: () => void | Promise<void>;
}

export default function AddTransactionModal(props: AddTransactionModalProps) {
  const fmt = useCurrency();
  let remembered = "";
  try {
    remembered = localStorage.getItem("money.lastAccountId") ?? "";
  } catch {
    /* Account selection also works without browser storage. */
  }
  const [accountId, setAccountId] = createSignal(
    props.initialAccountId ??
      (props.accounts.some((account) => account.id === remembered && !account.closed)
        ? remembered
        : (props.accounts.find((account) => !account.closed)?.id ?? "")),
  );
  const [kind, setKind] = createSignal<"expense" | "income">("expense");
  const [date, setDate] = createSignal(formatCalendarDate(new Date()));
  const [payee, setPayee] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [category, setCategory] = createSignal(props.initialCategoryId ?? "");
  const [notes, setNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let amountInput: HTMLInputElement | undefined;
  let categoryChosen = Boolean(props.initialCategoryId);
  // Payee history loads once per open; matching and category suggestions then stay in memory.
  const [history, setHistory] = createSignal<readonly PayeeHistoryEntry[]>([]);
  const [payeeOpen, setPayeeOpen] = createSignal(false);
  const [payeeActive, setPayeeActive] = createSignal(-1);
  const payeeMatches = createMemo(() => (payeeOpen() ? matchPayees(history(), payee()) : []));
  const categoryLabel = (id: string | null) => {
    const definition = props.categories.find((item) => item.id === id);
    return definition ? definition.name : "";
  };
  onMount(() => {
    api.payeeHistory().then(
      (result) => setHistory(result.payees),
      () => {
        /* Without history the payee field is plain text entry. */
      },
    );
  });
  function suggestCategory(name: string) {
    if (categoryChosen) return;
    const definition = props.categories.find(
      (item) => item.id === findPayee(history(), name)?.categoryId,
    );
    if (definition && (definition.isIncome ?? false) === (kind() === "income"))
      setCategory(definition.id);
  }
  function typePayee(value: string) {
    setPayee(value);
    setPayeeOpen(true);
    setPayeeActive(-1);
    suggestCategory(value);
  }
  function choosePayee(entry: PayeeHistoryEntry) {
    setPayee(entry.name);
    setPayeeOpen(false);
    suggestCategory(entry.name);
  }
  function payeeKeyDown(event: KeyboardEvent) {
    const matches = payeeMatches();
    if (!matches.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Cycles through the options and back to the typed text (-1).
      setPayeeActive(
        (index) => ((index + 1 + step + matches.length + 1) % (matches.length + 1)) - 1,
      );
    } else if (event.key === "Enter" && matches[payeeActive()]) {
      event.preventDefault();
      choosePayee(matches[payeeActive()]);
    } else if (event.key === "Escape") {
      // Close the list without letting the dialog treat Escape as cancel.
      event.preventDefault();
      event.stopPropagation();
      setPayeeOpen(false);
    }
  }
  function typeAmount(input: HTMLInputElement, inputType: string) {
    const money = fmt();
    let caret = input.selectionStart ?? input.value.length;
    let raw = input.value;
    const { decimal } = NUMBER_FORMAT_SEPS[money.numberFormat];
    const significant = (text: string) => {
      let count = 0;
      for (let index = 0; index < text.length; index++)
        if (/\d/.test(text[index]) || (money.code === "USD" && text[index] === decimal)) count++;
      return count;
    };
    // Backspacing over a grouping separator removes the digit before it instead.
    if (
      inputType === "deleteContentBackward" &&
      significant(raw) === significant(amount()) &&
      caret > 0
    ) {
      raw = raw.slice(0, caret - 1) + raw.slice(caret);
      caret--;
    }
    const formatted = formatAmountTyping(raw, money.code, money.numberFormat);
    // Keep the caret after the same digit it followed before separators moved.
    const before = significant(raw.slice(0, caret));
    let position = 0;
    for (let seen = 0; position < formatted.length && seen < before; position++)
      if (significant(formatted[position])) seen++;
    setAmount(formatted);
    input.value = formatted;
    input.setSelectionRange(position, position);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving()) return;
    const { decimal } = NUMBER_FORMAT_SEPS[fmt().numberFormat];
    const typed = amount();
    const cents = fmt().parseInput(typed.endsWith(decimal) ? typed.slice(0, -1) : typed);
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      setError("Enter an amount greater than zero.");
      amountInput?.focus();
      return;
    }
    if (!props.accounts.some((account) => account.id === accountId() && !account.closed)) {
      setError("Choose an open account.");
      return;
    }
    const another =
      event.submitter instanceof HTMLButtonElement && event.submitter.value === "another";
    setSaving(true);
    setError(null);
    try {
      await dispatch(
        "create_transaction",
        {
          row: {
            accountId: accountId(),
            date: date(),
            amount: kind() === "expense" ? -cents : cents,
            payee: payee().trim() || undefined,
            categoryId: category() || null,
            notes: notes().trim() || undefined,
            cleared: true,
          },
        },
        {
          undoInfo: {
            label: `Add ${kind()}`,
            inverse: (result) => ({
              commandType: "delete_transaction",
              payload: { id: requireCommandId(result) },
            }),
          },
        },
      ).promise;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save transaction");
      setSaving(false);
      return;
    }
    try {
      localStorage.setItem("money.lastAccountId", accountId());
    } catch {
      /* Saving a preference must not turn a committed transaction into a failure. */
    }
    emitMoneyDataChanged();
    if (another) {
      setPayee("");
      setAmount("");
      setNotes("");
      setCategory(
        kind() === "income"
          ? (props.categories.find((item) => item.isIncome)?.id ?? "")
          : (props.initialCategoryId ?? ""),
      );
      categoryChosen = kind() === "income" || Boolean(props.initialCategoryId);
      amountInput?.focus();
    } else props.onClose();
    setSaving(false);
    try {
      await props.onCreated?.();
    } catch {
      /* The transaction is committed; refresh failures must not offer duplicate submission. */
    }
  }
  return (
    <MoneyDialog title="Add transaction" onClose={props.onClose} busy={saving()}>
      <form class="money-form quick-composer" onSubmit={save}>
        <div class="segmented-control" aria-label="Transaction type">
          <button
            type="button"
            classList={{ active: kind() === "expense" }}
            disabled={saving()}
            onClick={() => {
              setKind("expense");
              setCategory("");
              categoryChosen = false;
              suggestCategory(payee());
            }}
          >
            Expense
          </button>
          <button
            type="button"
            classList={{ active: kind() === "income" }}
            disabled={saving()}
            onClick={() => {
              setKind("income");
              setCategory(props.categories.find((item) => item.isIncome)?.id ?? "");
              categoryChosen = true;
            }}
          >
            Income
          </button>
        </div>
        <label class="composer-amount">
          <span>{fmt().symbol}</span>
          <input
            ref={(element) => {
              amountInput = element;
            }}
            aria-label="Amount"
            autofocus
            type="text"
            inputmode={fmt().inputMode}
            placeholder="0"
            required
            value={amount()}
            onInput={(event) => typeAmount(event.currentTarget, event.inputType)}
            disabled={saving()}
          />
        </label>
        <div class="form-group">
          <label for="transaction-payee">{kind() === "expense" ? "Payee" : "From"}</label>
          <div class="payee-combobox">
            <input
              id="transaction-payee"
              type="text"
              role="combobox"
              autocomplete="off"
              aria-autocomplete="list"
              aria-controls="transaction-payee-options"
              aria-expanded={payeeMatches().length > 0}
              aria-activedescendant={
                payeeActive() >= 0 ? `transaction-payee-option-${payeeActive()}` : undefined
              }
              placeholder={kind() === "expense" ? "Where?" : "Who?"}
              value={payee()}
              onInput={(event) => typePayee(event.currentTarget.value)}
              onKeyDown={payeeKeyDown}
              onBlur={() => setPayeeOpen(false)}
              disabled={saving()}
            />
            <Show when={payeeMatches().length}>
              <ul class="payee-options" id="transaction-payee-options" role="listbox">
                <For each={payeeMatches()}>
                  {(entry, index) => (
                    <li
                      id={`transaction-payee-option-${index()}`}
                      role="option"
                      aria-selected={payeeActive() === index()}
                      // Pointer down keeps focus in the input so blur does not close the list first.
                      onPointerDown={(event) => {
                        event.preventDefault();
                        choosePayee(entry);
                      }}
                    >
                      <span>{entry.name}</span>
                      <span>{categoryLabel(entry.categoryId)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
        <div class="form-group">
          <label for="transaction-category">Category</label>
          <select
            id="transaction-category"
            value={category()}
            onChange={(event) => {
              categoryChosen = true;
              setCategory(event.currentTarget.value);
            }}
            disabled={saving()}
          >
            <option value="">Uncategorized</option>
            <For
              each={props.categories.filter(
                (item) => (item.isIncome ?? false) === (kind() === "income"),
              )}
            >
              {(item) => (
                <option value={item.id}>
                  {item.groupName ? `${item.groupName} / ` : ""}
                  {item.name}
                </option>
              )}
            </For>
          </select>
        </div>
        <details class="composer-details">
          <summary>
            <MoneyIcon name="accounts" size={17} />
            <span>
              {props.accounts.find((account) => account.id === accountId())?.name ?? "Account"}
            </span>
            <span>{date() === formatCalendarDate(new Date()) ? "Today" : date()}</span>
            <MoneyIcon name="settings" size={16} />
          </summary>
          <div class="composer-detail-fields">
            <div class="form-group">
              <label for="transaction-account">Account</label>
              <select
                id="transaction-account"
                value={accountId()}
                onChange={(event) => setAccountId(event.currentTarget.value)}
                disabled={saving()}
              >
                <For each={props.accounts.filter((account) => !account.closed)}>
                  {(account) => <option value={account.id}>{account.name}</option>}
                </For>
              </select>
            </div>
            <div class="form-group">
              <label for="transaction-date">Date</label>
              <input
                id="transaction-date"
                type="date"
                required
                value={date()}
                onInput={(event) => setDate(event.currentTarget.value)}
                disabled={saving()}
              />
            </div>
            <div class="form-group">
              <label for="transaction-notes">Note</label>
              <input
                id="transaction-notes"
                value={notes()}
                onInput={(event) => setNotes(event.currentTarget.value)}
                disabled={saving()}
              />
            </div>
          </div>
        </details>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="composer-footer">
          <button class="btn btn-ghost" type="submit" value="another" disabled={saving()}>
            Save &amp; another
          </button>
          <button class="btn btn-primary" type="submit" disabled={saving()}>
            {saving() ? "Saving…" : `Add ${kind()}`}
            <MoneyIcon name="arrow" size={17} />
          </button>
        </div>
      </form>
    </MoneyDialog>
  );
}
