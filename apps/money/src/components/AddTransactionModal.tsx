import { createSignal, For, onCleanup, Show } from "solid-js";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { emitMoneyDataChanged } from "../lib/data-events";
import { formatCalendarDate } from "../domain/types";
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
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let suggestionRequest = 0;
  let categoryChosen = Boolean(props.initialCategoryId);
  onCleanup(() => {
    clearTimeout(debounce);
    suggestionRequest++;
  });
  function suggest(value: string) {
    setPayee(value);
    clearTimeout(debounce);
    const request = ++suggestionRequest;
    if (!value.trim() || categoryChosen) return;
    debounce = setTimeout(async () => {
      try {
        const result = await api.payeeSuggestions(value.trim());
        if (request !== suggestionRequest || categoryChosen) return;
        const suggested = result.suggestions[0]?.category_id;
        const definition = props.categories.find((item) => item.id === suggested);
        if (definition && (definition.isIncome ?? false) === (kind() === "income"))
          setCategory(definition.id);
      } catch {
        /* A suggestion failure never blocks entry. */
      }
    }, 250);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving()) return;
    const cents = fmt().parseInput(amount());
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
      suggestionRequest++;
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
              suggestionRequest++;
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
              suggestionRequest++;
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
            onInput={(event) => setAmount(event.currentTarget.value)}
            disabled={saving()}
          />
        </label>
        <div class="form-group">
          <label for="transaction-payee">{kind() === "expense" ? "Payee" : "From"}</label>
          <input
            id="transaction-payee"
            type="text"
            placeholder={kind() === "expense" ? "Where?" : "Who?"}
            value={payee()}
            onInput={(event) => suggest(event.currentTarget.value)}
            disabled={saving()}
          />
        </div>
        <div class="form-group">
          <label for="transaction-category">Category</label>
          <select
            id="transaction-category"
            value={category()}
            onChange={(event) => {
              categoryChosen = true;
              suggestionRequest++;
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
