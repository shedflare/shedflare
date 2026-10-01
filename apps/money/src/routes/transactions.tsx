import { createSignal, createEffect, createMemo, onCleanup, onMount, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import TransactionFilters from "../components/TransactionFilters";
import TransactionTable from "../components/TransactionTable";
import ActivityFeed from "../components/ActivityFeed";
import TransactionDrawer from "../components/TransactionDrawer";
import { activityEntries, activityTotals, filterActivity } from "../lib/activity-view";
import { currentMonthKey, shiftMonth } from "../lib/budget-view";
import { useDateFormat } from "../lib/date-format";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
import MoneyIcon from "../components/MoneyIcon";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { listenForMoneyDataChanged } from "../lib/data-events";
import type { TransactionRow } from "../components/TransactionTable";
import type { Condition } from "../components/TransactionFilters";
import type {
  AccountsResponse,
  CategoriesResponse,
  TagsResponse,
  TransactionsResponse,
} from "../domain/schemas-client";

type CategoryRow = CategoriesResponse["categories"][number];
type AccountRow = AccountsResponse["accounts"][number];
type TagRow = Pick<TagsResponse["tags"][number], "id" | "name" | "color">;
type ApiTransactionRow = TransactionsResponse["transactions"][number];

function toTransactionRow(tx: ApiTransactionRow): TransactionRow {
  return {
    id: tx.id,
    accountId: tx.accountId,
    accountName: tx.accountName ?? undefined,
    date: tx.date,
    createdAt: tx.createdAt,
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
    transferId: tx.transferId,
    scheduleId: tx.scheduleId,
    scheduleName: tx.scheduleName ?? null,
  };
}

export default function AllTransactionsPage() {
  const shell = useMoneyShell();
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const df = useDateFormat();
  const [ledger, setLedger] = createSignal(false);
  const [searchParams, setSearchParams] = useSearchParams<{
    q?: string;
    view?: string;
    category?: string;
    month?: string;
    focus?: string;
  }>();
  const [transactions, setTransactions] = createSignal<ApiTransactionRow[]>([]);
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

  const month = createMemo(() =>
    searchParams.month === "all"
      ? null
      : /^\d{4}-(0[1-9]|1[0-2])$/.test(searchParams.month ?? "")
        ? searchParams.month!
        : currentMonthKey(),
  );
  const visibleTransactions = createMemo(() =>
    filterActivity(transactions(), {
      month: month(),
      category: searchParams.category,
      view: searchParams.view,
      query: searchQuery(),
    }),
  );

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

  let requestId = 0;
  async function loadData() {
    const request = ++requestId;
    setLoading(true);
    setError(null);
    try {
      const fId = filterId();
      const conditions = filterConditions();
      const [data, categoryData, accountData, tagData] = await Promise.all([
        api.transactions(
          fId
            ? { filterId: fId }
            : conditions.length > 0
              ? { conditions, conditionsOp: filterConditionsOp() }
              : undefined,
        ),
        api.categories(),
        api.accounts(),
        api.tags(),
      ]);
      if (request !== requestId) return;
      setTransactions([...data.transactions]);
      setCategories([...categoryData.categories]);
      setAccounts([...accountData.accounts]);
      setTagList([...tagData.tags]);
      const map: Record<string, { id: string; name: string; color: string | null }[]> = {};
      for (const tt of data.transactionTags ?? []) {
        (map[tt.transactionId] ??= []).push({ id: tt.tagId, name: tt.tagName, color: tt.tagColor });
      }
      setTxTags(map);
    } catch (err) {
      if (request !== requestId) return;
      setError(err instanceof Error ? err.message : "Failed to load activity");
    } finally {
      if (request === requestId) setLoading(false);
    }
  }

  const selected = createMemo(() => transactions().find((row) => row.id === searchParams.focus));
  const totals = createMemo(() =>
    activityTotals(visibleTransactions(), Boolean(searchParams.category)),
  );

  function accountNames() {
    const map: Record<string, string> = {};
    for (const account of accounts()) {
      map[account.id] = account.name;
    }
    return map;
  }

  function removeTransaction(id: string) {
    setTransactions((rows) => rows.filter((row) => row.id !== id));
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
    <div class="page activity-page">
      <div class="page-header">
        <div>
          <h1 class="page-title">Activity</h1>
        </div>
        <div class="page-actions">
          <button
            class="btn btn-secondary btn-sm"
            aria-pressed={ledger()}
            onClick={() => {
              setLedger(!ledger());
              setSearchParams({ focus: undefined }, { replace: true });
            }}
          >
            <MoneyIcon name="activity" size={16} />
            {ledger() ? "Feed" : "Ledger"}
          </button>
          <button class="btn btn-primary btn-sm" onClick={() => shell.openTransaction()}>
            <MoneyIcon name="plus" />
            Add
          </button>
        </div>
      </div>

      <div class="activity-period">
        <div class="month-nav">
          <button
            class="btn btn-icon btn-ghost"
            aria-label="Previous activity month"
            onClick={() => setSearchParams({ month: shiftMonth(month() ?? currentMonthKey(), -1) })}
          >
            ‹
          </button>
          <h2>{month() ? df().formatMonth(month()!) : "All time"}</h2>
          <button
            class="btn btn-icon btn-ghost"
            aria-label="Next activity month"
            onClick={() => setSearchParams({ month: shiftMonth(month() ?? currentMonthKey(), 1) })}
          >
            ›
          </button>
        </div>
        <button
          class="text-button"
          onClick={() => setSearchParams({ month: month() ? "all" : undefined })}
        >
          {month() ? "All time" : "This month"}
        </button>
      </div>
      <Show when={!loading() && !error() && visibleTransactions().length}>
        <div class="activity-summary">
          <div>
            <span>Money out</span>
            <strong class={privacy().blurClass()}>{fmt().formatCents(totals().expense)}</strong>
          </div>
          <div>
            <span>Money in</span>
            <strong class={privacy().blurClass()}>{fmt().formatCents(totals().income)}</strong>
          </div>
        </div>
      </Show>
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
      </div>

      <Show when={searchParams.category}>
        <div class="active-view-chip">
          {[categories().find((category) => category.id === searchParams.category)?.name]
            .filter(Boolean)
            .join(" · ")}
          <button
            type="button"
            aria-label="Show all transactions"
            onClick={() =>
              setSearchParams({ category: undefined, focus: undefined }, { replace: true })
            }
          >
            ×
          </button>
        </div>
      </Show>

      <div class="activity-filter-tools">
        <span>{activityEntries(visibleTransactions()).length} transactions</span>
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
      </div>

      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadData}
        loadingMessage="Loading transactions..."
      >
        <Show
          when={activityEntries(visibleTransactions()).length > 0}
          fallback={
            <div class="money-empty">
              <span class="money-empty-icon">
                <MoneyIcon name="activity" size={32} />
              </span>
              <h2>
                {searchQuery() ||
                searchParams.category ||
                searchParams.view ||
                filterId() ||
                filterConditions().length
                  ? "No matching activity"
                  : "No activity yet"}
              </h2>
              <Show
                when={
                  !searchQuery() &&
                  !searchParams.category &&
                  !searchParams.view &&
                  !filterId() &&
                  !filterConditions().length
                }
                fallback={
                  <button
                    class="btn btn-secondary"
                    onClick={() => {
                      setSearchQuery("");
                      setSearchParams({ q: undefined, category: undefined, view: undefined });
                      handleFilterChange([], "and", null);
                    }}
                  >
                    Clear filters
                  </button>
                }
              >
                <button class="btn btn-primary" onClick={() => shell.openTransaction()}>
                  <MoneyIcon name="plus" />
                  Add transaction
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={ledger()}
            fallback={
              <ActivityFeed
                transactions={visibleTransactions()}
                categories={categories()}
                onSelect={(id) => setSearchParams({ focus: id })}
              />
            }
          >
            <TransactionTable
              transactions={visibleTransactions().map(toTransactionRow)}
              categories={categories().map((row) => ({
                id: row.id,
                name: row.name,
                groupName: row.group_name ?? null,
              }))}
              txTags={txTags()}
              tagList={tagList()}
              showAccount
              accountNames={accountNames()}
              onReload={loadData}
              onTransactionRemove={removeTransaction}
              onTransactionRestore={() => void loadData()}
              focusId={searchParams.focus}
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
        </Show>
      </PageState>
      <Show when={searchParams.focus && !loading() && !error() && !selected()}>
        <p class="form-error" role="alert">
          This transaction is no longer available.
          <button
            class="text-button"
            onClick={() => setSearchParams({ focus: undefined }, { replace: true })}
          >
            Dismiss
          </button>
        </p>
      </Show>
      <Show when={!ledger() && selected()?.id} keyed>
        {(id) => (
          <TransactionDrawer
            transaction={transactions().find((row) => row.id === id)!}
            categories={categories()}
            accounts={accounts()}
            children={transactions().filter((row) => row.parentId === id)}
            tags={txTags()[id] ?? []}
            onClose={() => setSearchParams({ focus: undefined }, { replace: true })}
            onLedger={() => setLedger(true)}
          />
        )}
      </Show>
    </div>
  );
}
