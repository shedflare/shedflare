import { createMemo, createSignal, For, Show } from "solid-js";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import CategoryBadge from "./CategoryBadge";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { dispatch } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { parseCalendarDate } from "../domain/types";
import type { CommandPayloadMap } from "../domain/commands";
import type { AccountsResponse } from "../domain/schemas-client";
import type { ActivityCategory, ActivityTransaction } from "./ActivityFeed";

type Fields = {
  -readonly [Key in keyof CommandPayloadMap["update_transaction"]["fields"]]: CommandPayloadMap["update_transaction"]["fields"][Key];
};

export default function TransactionDrawer(props: {
  transaction: ActivityTransaction;
  categories: readonly ActivityCategory[];
  accounts: AccountsResponse["accounts"];
  children: readonly ActivityTransaction[];
  tags: readonly { id: string; name: string; color: string | null }[];
  onClose: () => void;
  onLedger: () => void;
}) {
  const original = props.transaction;
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const [amount, setAmount] = createSignal(fmt().formatCentsInput(Math.abs(original.amount)));
  const [income, setIncome] = createSignal(original.amount >= 0);
  const [payee, setPayee] = createSignal(original.payee ?? "");
  const [categoryId, setCategoryId] = createSignal<string | null>(original.categoryId);
  const [accountId, setAccountId] = createSignal<string>(original.accountId);
  const [date, setDate] = createSignal(original.date);
  const [notes, setNotes] = createSignal(original.notes ?? "");
  const [cleared, setCleared] = createSignal(original.cleared);
  const [picking, setPicking] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const special =
    original.isParent || original.isChild || !!original.transferId || original.startingBalanceFlag;
  const locked = special || original.reconciled;
  const category = createMemo(() => props.categories.find((row) => row.id === categoryId()));
  const visibleCategories = createMemo(() =>
    props.categories.filter(
      (row) =>
        (!row.hidden || row.id === original.categoryId) &&
        `${row.name} ${row.group_name ?? ""}`
          .toLocaleLowerCase()
          .includes(query().trim().toLocaleLowerCase()),
    ),
  );
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || special) return;
    const value = fmt().parseInput(amount());
    if (!locked && (!Number.isSafeInteger(value) || value <= 0)) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (!parseCalendarDate(date())) {
      setError("Choose a valid date.");
      return;
    }
    const fields: Fields = {};
    const inverse: Fields = {};
    const signed = income() ? value : -value;
    if (!locked && signed !== original.amount) {
      fields.amount = signed;
      inverse.amount = original.amount;
    }
    if (!locked && date() !== original.date) {
      fields.date = date();
      inverse.date = original.date;
    }
    if (!locked && accountId() !== original.accountId) {
      fields.accountId = accountId();
      inverse.accountId = original.accountId;
    }
    if (payee() !== (original.payee ?? "")) {
      fields.payee = payee().trim();
      inverse.payee = original.payee;
    }
    if (notes() !== (original.notes ?? "")) {
      fields.notes = notes();
      inverse.notes = original.notes;
    }
    if (categoryId() !== original.categoryId) {
      fields.categoryId = categoryId();
      inverse.categoryId = original.categoryId;
    }
    if (!original.reconciled && cleared() !== original.cleared) {
      fields.cleared = cleared();
      inverse.cleared = original.cleared;
    }
    if (!Object.keys(fields).length) {
      props.onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "update_transaction",
        { id: original.id, fields },
        {
          undoInfo: {
            label: "Transaction updated",
            inverse: {
              commandType: "update_transaction",
              payload: { id: original.id, fields: inverse },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save transaction");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy() || special) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "delete_transaction",
        { id: original.id },
        {
          undoInfo: {
            label: "Transaction deleted",
            inverse: {
              commandType: "create_transaction",
              payload: {
                row: {
                  accountId: original.accountId,
                  date: original.date,
                  amount: original.amount,
                  payee: original.payee ?? undefined,
                  notes: original.notes ?? undefined,
                  categoryId: original.categoryId,
                  cleared: original.cleared,
                  reconciled: original.reconciled,
                  isParent: original.isParent,
                  isChild: original.isChild,
                  parentId: original.parentId,
                  scheduleId: original.scheduleId,
                },
              },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete transaction");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog
      title={special ? "Transaction details" : "Edit transaction"}
      drawer
      busy={busy()}
      onClose={props.onClose}
    >
      <form class="transaction-sheet" onSubmit={(event) => void save(event)}>
        <Show when={!locked}>
          <div class="filter-chips transaction-kind">
            <button
              type="button"
              disabled={busy()}
              classList={{ active: !income() }}
              onClick={() => setIncome(false)}
            >
              Expense
            </button>
            <button
              type="button"
              disabled={busy()}
              classList={{ active: income() }}
              onClick={() => setIncome(true)}
            >
              Income
            </button>
          </div>
        </Show>
        <Show
          when={!locked}
          fallback={
            <div
              class={`transaction-sheet-total ${privacy().blurClass()}`}
              classList={{ "text-positive": original.amount > 0 }}
            >
              {original.amount > 0 ? "+" : ""}
              {fmt().formatCents(original.amount)}
            </div>
          }
        >
          <label class="transaction-sheet-amount">
            <span>{fmt().symbol}</span>
            <input
              aria-label="Amount"
              type="text"
              inputmode={fmt().inputMode}
              disabled={busy()}
              class={privacy().blurClass()}
              value={amount()}
              onInput={(event) => setAmount(event.currentTarget.value)}
            />
          </label>
        </Show>
        <Show when={original.reconciled}>
          <p class="transaction-lock">
            <MoneyIcon name="check" size={14} />
            Reconciled · balance locked
          </p>
        </Show>
        <fieldset disabled={busy() || special} class="transaction-edit-fields">
          <label class="form-group">
            <span class="form-label">Payee</span>
            <input
              value={payee()}
              placeholder="Add payee"
              onInput={(event) => setPayee(event.currentTarget.value)}
            />
          </label>
          <div class="form-group">
            <span class="form-label" id="transaction-category-label">
              Category
            </span>
            <button
              type="button"
              class="transaction-category-button"
              aria-labelledby="transaction-category-label"
              aria-expanded={picking()}
              onClick={() => {
                setPicking(!picking());
                setQuery("");
              }}
            >
              <CategoryBadge
                name={category()?.name ?? "Uncategorized"}
                icon={category()?.icon}
                small
              />
              <strong>
                {special
                  ? original.isParent || original.isChild
                    ? "Split transaction"
                    : original.transferId
                      ? "Transfer"
                      : "Starting balance"
                  : (category()?.name ?? "Uncategorized")}
              </strong>
              <MoneyIcon name="arrow" size={16} />
            </button>
          </div>
          <Show when={picking()}>
            <div class="transaction-category-picker">
              <label class="compact-search">
                <MoneyIcon name="search" size={16} />
                <input
                  type="search"
                  aria-label="Find transaction category"
                  placeholder="Find category"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
              <div class="transaction-category-options">
                <button
                  type="button"
                  classList={{ selected: categoryId() === null }}
                  onClick={() => {
                    setCategoryId(null);
                    setPicking(false);
                  }}
                >
                  Uncategorized
                </button>
                <For each={visibleCategories()}>
                  {(row) => (
                    <button
                      type="button"
                      classList={{ selected: categoryId() === row.id }}
                      onClick={() => {
                        setCategoryId(row.id);
                        setPicking(false);
                      }}
                    >
                      <CategoryBadge name={row.name} icon={row.icon} small />
                      <span>
                        {row.name}
                        <small>{row.group_name ?? (row.isIncome ? "Income" : "")}</small>
                      </span>
                      <Show when={categoryId() === row.id}>
                        <MoneyIcon name="check" size={16} />
                      </Show>
                    </button>
                  )}
                </For>
                <Show when={!visibleCategories().length}>
                  <p class="quiet-empty">No categories match.</p>
                </Show>
              </div>
            </div>
          </Show>
          <div class="transaction-date-account">
            <label class="form-group">
              <span class="form-label">Date</span>
              <input
                type="date"
                disabled={locked}
                required
                value={date()}
                onInput={(event) => setDate(event.currentTarget.value)}
              />
            </label>
            <label class="form-group">
              <span class="form-label">Account</span>
              <select
                aria-label="Account"
                disabled={locked}
                value={accountId()}
                onChange={(event) => setAccountId(event.currentTarget.value)}
              >
                <For
                  each={props.accounts.filter(
                    (row) => !row.closed || row.id === original.accountId,
                  )}
                >
                  {(row) => <option value={row.id}>{row.name}</option>}
                </For>
              </select>
            </label>
          </div>
          <label class="form-group">
            <span class="form-label">Note</span>
            <textarea
              rows={2}
              placeholder="Add a note"
              value={notes()}
              onInput={(event) => setNotes(event.currentTarget.value)}
            />
          </label>
          <label class="transaction-cleared">
            <input
              type="checkbox"
              aria-label="Cleared"
              checked={cleared()}
              disabled={original.reconciled}
              onChange={(event) => setCleared(event.currentTarget.checked)}
            />
            <span>Cleared</span>
            <small>{cleared() ? "Settled" : "Pending"}</small>
          </label>
        </fieldset>
        <Show when={props.children.length}>
          <div class="transaction-split-summary">
            <For each={props.children}>
              {(row) => (
                <div>
                  <span>{row.categoryName ?? "Uncategorized"}</span>
                  <strong class={privacy().blurClass()}>{fmt().formatCents(row.amount)}</strong>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.tags.length}>
          <div class="transaction-sheet-tags">
            <For each={props.tags}>{(tag) => <span>{tag.name}</span>}</For>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="transaction-sheet-footer">
          <button
            type="button"
            class="btn btn-secondary"
            disabled={busy()}
            onClick={props.onLedger}
          >
            Open ledger
          </button>
          <Show when={!special}>
            <div class="transaction-sheet-footer-actions">
              <button type="button" class="btn btn-danger" disabled={busy()} onClick={remove}>
                Delete
              </button>
              <button type="submit" class="btn btn-primary" disabled={busy()}>
                {busy() ? "Saving…" : "Save changes"}
              </button>
            </div>
          </Show>
        </div>
      </form>
    </MoneyDialog>
  );
}
