import { createSignal, createEffect, createMemo, onCleanup, onMount, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import TransactionFilters from "../components/TransactionFilters";
import TransactionTable from "../components/TransactionTable";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
import MoneyIcon from "../components/MoneyIcon";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { listenForMoneyDataChanged } from "../lib/data-events";
import type { TransactionPatch, TransactionRow } from "../components/TransactionTable";
import type { Condition } from "../components/TransactionFilters";
import type {
  AccountsResponse,
  CategoriesResponse,
  TagsResponse,
  TransactionsResponse,
} from "../domain/schemas-client";

type CategoryRow = Pick<CategoriesResponse["categories"][number], "id" | "name"> & {
  groupName: string | null;
};
type AccountRow = Pick<AccountsResponse["accounts"][number], "id" | "name" | "closed">;
type TagRow = Pick<TagsResponse["tags"][number], "id" | "name" | "color">;
type ApiTransactionRow = TransactionsResponse["transactions"][number];

function toTransactionRow(tx: ApiTransactionRow): TransactionRow {
  return {
    id: tx.id,
    accountId: tx.accountId,
    accountName: tx.accountName ?? undefined,
    date: tx.date,
    amount: tx.amount,
    payee: tx.payee,
    categoryId: tx.categoryId,
    categoryName: tx.categoryName ?? null,
    notes: tx.notes,
    cleared: tx.cleared,
    reconciled: tx.reconciled,
    isParent: tx.isParent,
    isChild: tx.isChild,
    parentId: tx.parentId,
    scheduleId: tx.scheduleId,
    scheduleName: tx.scheduleName ?? null,
  };
}

export default function AllTransactionsPage() {
  const shell = useMoneyShell();
  const [searchParams, setSearchParams] = useSearchParams<{
    q?: string;
    view?: string;
    category?: string;
    month?: string;
    focus?: string;
  }>();
  const [transactions, setTransactions] = createSignal<TransactionRow[]>([]);
  const [categories, setCategories] = createSignal<CategoryRow[]>([]);
  const [tagList, setTagList] = createSignal<TagRow[]>([]);
  const [txTags, setTxTags] = createSignal<
    Record<string, { id: string; name: string; color: string | null }[]>
  >({});
  const [accounts, setAccounts] = createSignal<AccountRow[]>([]);
  const [searchQuery, setSearchQuery] = createSignal(searchParams.q ?? "");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const [filterId, setFilterId] = createSignal<string | null>(null);
  const [filterConditions, setFilterConditions] = createSignal<Condition[]>([]);
  const [filterConditionsOp, setFilterConditionsOp] = createSignal<"and" | "or">("and");

  createEffect(() => {
    const query = searchParams.q ?? "";
    if (query !== searchQuery()) setSearchQuery(query);
  });

  onMount(() => {
    onCleanup(listenForMoneyDataChanged(loadData));
  });

  const visibleTransactions = createMemo(() => {
    const query = searchQuery().trim().toLocaleLowerCase();
    const base = transactions().filter((transaction) => {
      if (searchParams.focus && transaction.id !== searchParams.focus) return false;
      if (searchParams.category && transaction.categoryId !== searchParams.category) return false;
      if (
        /^\d{4}-(0[1-9]|1[0-2])$/.test(searchParams.month ?? "") &&
        transaction.date.slice(0, 7) !== searchParams.month
      )
        return false;
      if (
        searchParams.view === "uncategorized" &&
        (transaction.categoryId !== null || transaction.isParent)
      )
        return false;
      if (searchParams.view === "expenses" && transaction.amount >= 0) return false;
      if (searchParams.view === "income" && transaction.amount <= 0) return false;
      return true;
    });
    if (!query) return base;
    const names = accountNames();
    return base.filter((transaction) =>
      [
        transaction.payee,
        transaction.notes,
        transaction.categoryName,
        names[transaction.accountId],
        transaction.date,
      ].some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  });

  function handleFilterChange(
    conditions: Condition[],
    conditionsOp: "and" | "or",
    fId: string | null,
  ) {
    setFilterConditions(conditions);
    setFilterConditionsOp(conditionsOp);
    setFilterId(fId);
    setLoading(true);
  }

  createEffect(() => {
    filterId();
    filterConditions();
    filterConditionsOp();
    void loadData();
  });

  createEffect(() => {
    void loadCategories();
    void loadTags();
    void loadAccounts();
  });

  async function loadData() {
    setError(null);
    try {
      const fId = filterId();
      const conditions = filterConditions();
      const data = await api.transactions(
        fId
          ? { filterId: fId }
          : conditions.length > 0
            ? { conditions, conditionsOp: filterConditionsOp() }
            : undefined,
      );
      setTransactions(data.transactions.map(toTransactionRow));
      const map: Record<string, { id: string; name: string; color: string | null }[]> = {};
      for (const tt of data.transactionTags ?? []) {
        if (!map[tt.transactionId]) map[tt.transactionId] = [];
        map[tt.transactionId].push({
          id: tt.tagId,
          name: tt.tagName,
          color: tt.tagColor,
        });
      }
      setTxTags(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load transactions");
    } finally {
      setLoading(false);
    }
  }

  async function loadCategories() {
    try {
      const data = await api.categories();
      setCategories(
        data.categories.map((c) => ({ id: c.id, name: c.name, groupName: c.group_name ?? null })),
      );
    } catch {
      console.warn("[transactions] failed to load categories");
    }
  }

  async function loadTags() {
    try {
      const data = await api.tags();
      setTagList([...data.tags]);
    } catch {
      console.warn("[transactions] failed to load tags");
    }
  }

  async function loadAccounts() {
    try {
      const data = await api.accounts();
      setAccounts(
        data.accounts.map((account) => ({
          id: account.id,
          name: account.name,
          closed: account.closed,
        })),
      );
    } catch {
      console.warn("[transactions] failed to load accounts");
    }
  }

  function patchTransaction(id: string, patch: TransactionPatch) {
    setTransactions((prev) => prev.map((tx) => (tx.id === id ? { ...tx, ...patch } : tx)));
  }

  function removeTransaction(id: string) {
    setTransactions((prev) => prev.filter((tx) => tx.id !== id));
  }

  function restoreTransaction(tx: TransactionRow) {
    setTransactions((prev) => (prev.some((item) => item.id === tx.id) ? prev : [tx, ...prev]));
  }

  function accountNames() {
    const map: Record<string, string> = {};
    for (const account of accounts()) {
      map[account.id] = account.name;
    }
    return map;
  }

  function addTransactionTag(
    txId: string,
    tag: { id: string; name: string; color: string | null },
  ) {
    setTxTags((prev) => {
      const tags = prev[txId] ?? [];
      if (tags.some((item) => item.id === tag.id)) return prev;
      return { ...prev, [txId]: [...tags, tag] };
    });
  }

  function removeTransactionTag(txId: string, tagId: string) {
    setTxTags((prev) => ({
      ...prev,
      [txId]: (prev[txId] ?? []).filter((tag) => tag.id !== tagId),
    }));
  }

  return (
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Activity</h1>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary btn-sm" onClick={() => shell.openTransaction()}>
            <MoneyIcon name="plus" />
            Add
          </button>
        </div>
      </div>

      <div class="transaction-search">
        <MoneyIcon name="search" size={18} />
        <input
          type="search"
          aria-label="Search transactions"
          placeholder="Search activity"
          value={searchQuery()}
          onInput={(event) => {
            const query = event.currentTarget.value;
            setSearchQuery(query);
            setSearchParams({ q: query.trim() || undefined }, { replace: true });
          }}
        />
        <Show when={searchQuery()}>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => {
              setSearchQuery("");
              setSearchParams({ q: undefined }, { replace: true });
            }}
          >
            Clear
          </button>
        </Show>
      </div>

      <div class="activity-controls">
        <div class="filter-chips" aria-label="Activity views">
          <button
            classList={{ active: !searchParams.view }}
            onClick={() => setSearchParams({ view: undefined })}
          >
            All
          </button>
          <button
            classList={{ active: searchParams.view === "expenses" }}
            onClick={() => setSearchParams({ view: "expenses" })}
          >
            Expenses
          </button>
          <button
            classList={{ active: searchParams.view === "income" }}
            onClick={() => setSearchParams({ view: "income" })}
          >
            Income
          </button>
          <button
            classList={{ active: searchParams.view === "uncategorized" }}
            onClick={() => setSearchParams({ view: "uncategorized" })}
          >
            Uncategorized
          </button>
        </div>
        <span class="text-muted">
          {visibleTransactions().filter((transaction) => !transaction.isChild).length} transactions
        </span>
      </div>

      <Show when={searchParams.category || searchParams.month || searchParams.focus}>
        <div class="active-view-chip">
          {searchParams.focus
            ? "Selected transaction"
            : [
                categories().find((category) => category.id === searchParams.category)?.name,
                searchParams.month,
              ]
                .filter(Boolean)
                .join(" · ")}
          <button
            type="button"
            aria-label="Show all transactions"
            onClick={() =>
              setSearchParams(
                { category: undefined, month: undefined, focus: undefined },
                { replace: true },
              )
            }
          >
            ×
          </button>
        </div>
      </Show>

      <details class="activity-advanced">
        <summary>
          <MoneyIcon name="settings" size={16} />
          Filters
          <Show when={filterConditions().length}>
            <span>({filterConditions().length})</span>
          </Show>
        </summary>
        <TransactionFilters
          activeConditions={filterConditions()}
          activeConditionsOp={filterConditionsOp()}
          onConditionsChange={handleFilterChange}
        />
      </details>

      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadData}
        loadingMessage="Loading transactions..."
      >
        <Show
          when={visibleTransactions().length > 0}
          fallback={
            <div class="empty-state">
              {searchQuery()
                ? `No transactions match “${searchQuery()}”.`
                : "No transactions found."}
            </div>
          }
        >
          <TransactionTable
            transactions={visibleTransactions()}
            categories={categories()}
            txTags={txTags()}
            tagList={tagList()}
            showAccount
            accountNames={accountNames()}
            onReload={loadData}
            focusId={searchParams.focus}
            onTransactionPatch={patchTransaction}
            onTransactionRemove={removeTransaction}
            onTransactionRestore={restoreTransaction}
            onTagAdd={addTransactionTag}
            onTagRemove={removeTransactionTag}
            onCreateSchedule={(tx) => {
              dispatch(
                "create_schedule",
                {
                  schedule: {
                    accountId: tx.accountId,
                    categoryId: tx.categoryId,
                    name: tx.payee ?? "From transaction",
                    amount: tx.amount,
                    recurrenceRules: JSON.stringify({ type: "monthly" }),
                    startDate: new Date().toISOString().slice(0, 10),
                  },
                },
                {
                  undoInfo: {
                    label: "Create schedule from transaction",
                    inverse: (data) => ({
                      commandType: "delete_schedule",
                      payload: { id: requireCommandId(data) },
                    }),
                  },
                },
              );
            }}
          />
        </Show>
      </PageState>
    </div>
  );
}
