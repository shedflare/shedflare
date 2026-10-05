import { createSignal, createEffect, createMemo, onCleanup, onMount, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import TransactionFilters from "./TransactionFilters";
import TransactionTable from "./TransactionTable";
import ActivityFeed from "./ActivityFeed";
import TransactionDrawer from "./TransactionDrawer";
import { activityEntries, activityTotals, filterActivity } from "../lib/activity-view";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { PageState } from "./PageState";
import { useMoneyShell } from "./MoneyShellContext";
import MoneyIcon from "./MoneyIcon";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { listenForMoneyDataChanged } from "../lib/data-events";
import type { TransactionRow } from "./TransactionTable";
import type { Condition } from "./TransactionFilters";
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

export type ActivityParams = {
  q?: string;
  view?: string;
  category?: string;
  account?: string;
  month?: string;
  focus?: string;
};

/** Searchable feed/ledger for one month (or all time when `month` is null), driven by URL filters. */
export default function ActivityPanel(props: {
  month: string | null;
  /** Receives the full unfiltered transaction list whenever it is (re)loaded without server filters. */
  onLoaded?: (rows: readonly ApiTransactionRow[]) => void;
}) {
  const shell = useMoneyShell();
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const [ledger, setLedger] = createSignal(false);
  const [searchParams, setSearchParams] = useSearchParams<ActivityParams>();
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
    onCleanup(listenForMoneyDataChanged(() => loadData(false)));
  });

  const visibleTransactions = createMemo(() =>
    filterActivity(transactions(), {
      month: props.month,
      category: searchParams.category,
      account: searchParams.account,
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
  async function loadData(showLoading = true) {
    const request = ++requestId;
    if (showLoading) setLoading(true);
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
      if (!fId && !conditions.length) props.onLoaded?.(data.transactions);
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
  const filtered = () =>
    Boolean(
      searchQuery() ||
      searchParams.category ||
      searchParams.account ||
      searchParams.view ||
      filterId() ||
      filterConditions().length,
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
    <section class="activity-panel">
      <div class="activity-panel-toolbar">
        <div class="transaction-search">
          <MoneyIcon name="search" size={17} />
          <input
            type="search"
            aria-label="Search transactions"
            placeholder="Search payee, notes, category, account"
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
            Out
          </button>
          <button
            classList={{ active: searchParams.view === "income" }}
            onClick={() => setSearchParams({ view: "income" })}
          >
            In
          </button>
          <button
            classList={{ active: searchParams.view === "uncategorized" }}
            onClick={() => setSearchParams({ view: "uncategorized" })}
          >
            Uncategorized
          </button>
        </div>
        <button
          class="btn btn-secondary btn-sm"
          aria-pressed={ledger()}
          onClick={() => {
            setLedger(!ledger());
            setSearchParams({ focus: undefined }, { replace: true });
          }}
          title={ledger() ? "Switch to the grouped feed" : "Switch to the editable ledger"}
        >
          <MoneyIcon name="activity" size={15} />
          {ledger() ? "Feed" : "Ledger"}
        </button>
      </div>

      <div class="activity-panel-filters">
        <Show when={searchParams.account}>
          <div class="active-view-chip">
            {accounts().find((account) => account.id === searchParams.account)?.name ?? "Account"}
            <button
              type="button"
              aria-label="Show every account"
              onClick={() => setSearchParams({ account: undefined }, { replace: true })}
            >
              ×
            </button>
          </div>
        </Show>
        <Show when={searchParams.category}>
          <div class="active-view-chip">
            {categories().find((category) => category.id === searchParams.category)?.name ??
              "Category"}
            <button
              type="button"
              aria-label="Show every category"
              onClick={() => setSearchParams({ category: undefined }, { replace: true })}
            >
              ×
            </button>
          </div>
        </Show>
        <span class={`activity-panel-count ${privacy().blurClass()}`}>
          {activityEntries(visibleTransactions()).length} transactions
          <Show when={!loading() && !error() && visibleTransactions().length}>
            {" · "}
            <span>{fmt().formatCents(totals().expense)} out</span>
            {" · "}
            <span class="money-in">+{fmt().formatCents(totals().income)} in</span>
          </Show>
        </span>
        <details class="activity-advanced">
          <summary>
            <MoneyIcon name="settings" size={15} />
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
              <h2>{filtered() ? "No matching activity" : "Nothing happened this month"}</h2>
              <Show
                when={!filtered()}
                fallback={
                  <button
                    class="btn btn-secondary"
                    onClick={() => {
                      setSearchQuery("");
                      setSearchParams({
                        q: undefined,
                        category: undefined,
                        account: undefined,
                        view: undefined,
                      });
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
    </section>
  );
}
