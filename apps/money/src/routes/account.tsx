import { createSignal, createMemo, createEffect, For, onCleanup, onMount, Show } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { execute, api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import TransactionFilters from "../components/TransactionFilters";
import TransactionTable from "../components/TransactionTable";
import MoneyDialog from "../components/MoneyDialog";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
import { parseCsv } from "../domain/csv-import";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import type { TagInfo, TransactionPatch, TransactionRow } from "../components/TransactionTable";
import type { Condition } from "../components/TransactionFilters";
import type {
  AccountApi,
  AccountsResponse,
  AccountTransactionsResponse,
  CategoriesResponse,
} from "../domain/schemas-client";

type CategoryRow = Pick<CategoriesResponse["categories"][number], "id" | "name"> & {
  groupName: string | null;
};
type ApiTransactionRow = AccountTransactionsResponse["transactions"][number];
type AccountOption = Pick<AccountsResponse["accounts"][number], "id" | "name" | "closed">;

function toTransactionRow(tx: ApiTransactionRow): TransactionRow {
  return {
    id: tx.id,
    accountId: tx.accountId,
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

export default function AccountPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const shell = useMoneyShell();
  const [account, setAccount] = createSignal<AccountApi | null>(null);
  const [accountOptions, setAccountOptions] = createSignal<AccountOption[]>([]);
  const [transactions, setTransactions] = createSignal<TransactionRow[]>([]);
  const [categories, setCategories] = createSignal<CategoryRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [showImport, setShowImport] = createSignal(false);
  const [showReconcile, setShowReconcile] = createSignal(false);
  const accountId = () => params.id;
  const fmt = useCurrency();
  const privacyBlur = usePrivacyMode();

  const [filterId, setFilterId] = createSignal<string | null>(null);
  const [filterConditions, setFilterConditions] = createSignal<Condition[]>([]);
  const [filterConditionsOp, setFilterConditionsOp] = createSignal<"and" | "or">("and");

  const [tagList, setTagList] = createSignal<TagInfo[]>([]);
  const [txTags, setTxTags] = createSignal<
    Record<string, { id: string; name: string; color: string | null }[]>
  >({});

  const reconciliableTransactions = createMemo(() =>
    transactions().filter((tx) => tx.cleared && !tx.reconciled && !tx.isChild),
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
    if (accountId()) {
      void loadAccount();
      void loadCategories();
      void loadTags();
    }
  });

  onMount(() => {
    onCleanup(listenForMoneyDataChanged(loadAccount));
  });

  async function loadAccount() {
    setError(null);
    try {
      const fId = filterId();
      const conditions = filterConditions();
      const txQuery = fId
        ? { filterId: fId }
        : conditions.length > 0
          ? { conditions, conditionsOp: filterConditionsOp() }
          : undefined;
      const [acctData, txData, txTagsData, accountsData] = await Promise.all([
        api.account(accountId()),
        api.accountTransactions(accountId(), txQuery),
        api.accountTags(accountId()),
        api.accounts(),
      ]);
      setAccount(acctData);
      setAccountOptions(
        accountsData.accounts.map(({ id, name, closed }) => ({ id, name, closed })),
      );
      setTransactions(txData.transactions.map(toTransactionRow));
      const map: Record<string, { id: string; name: string; color: string | null }[]> = {};
      for (const tt of txTagsData.transactionTags ?? []) {
        const txId = tt.transactionId;
        if (!map[txId]) map[txId] = [];
        map[txId].push({
          id: tt.tagId,
          name: tt.tagName,
          color: tt.tagColor,
        });
      }
      setTxTags(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load account");
    } finally {
      setLoading(false);
    }
  }

  async function loadCategories() {
    try {
      const data = await api.categories();
      setCategories(
        data.categories.map((category) => ({
          id: category.id,
          name: category.name,
          groupName: category.group_name ?? null,
        })),
      );
    } catch {
      console.warn("[account] failed to load categories");
    }
  }

  async function loadTags() {
    try {
      const data = await api.tags();
      setTagList([...data.tags]);
    } catch {
      console.warn("[account] failed to load tags");
    }
  }

  async function handleCloseAccount() {
    await dispatch(
      "close_account",
      { id: accountId() },
      {
        undoInfo: {
          label: "Close account",
          inverse: { commandType: "reopen_account", payload: { id: accountId() } },
        },
      },
    ).promise;
    navigate("/accounts");
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

  function addTransactionTag(txId: string, tag: TagInfo) {
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

  const runningBalance = createMemo(() => account()?.balanceCurrent ?? 0);

  return (
    <div class="page">
      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadAccount}
        loadingMessage="Loading account..."
      >
        <div class="page-header">
          <div class="account-switcher-wrap">
            <label for="account-switcher">Account</label>
            <select
              id="account-switcher"
              class="account-switcher"
              value={accountId()}
              onChange={(event) =>
                navigate(`/accounts/${event.currentTarget.value}`, { replace: true })
              }
            >
              <For each={accountOptions().filter((option) => !option.closed)}>
                {(option) => <option value={option.id}>{option.name}</option>}
              </For>
            </select>
          </div>
          <div class="page-actions">
            <button class="btn btn-secondary btn-sm" onClick={() => setShowImport(true)}>
              Import CSV
            </button>
            <button
              class="btn btn-primary btn-sm"
              onClick={() => shell.openTransaction({ initialAccountId: accountId() })}
            >
              + Add Transaction
            </button>
            <button class="btn btn-secondary btn-sm" onClick={() => setShowReconcile(true)}>
              Reconcile
            </button>
            <button class="btn btn-ghost btn-sm" onClick={handleCloseAccount}>
              Close Account
            </button>
          </div>
        </div>

        <Show when={account()}>
          <div class="account-header">
            <div class={`account-balance-large ${privacyBlur().blurClass()}`}>
              {fmt().formatCents(runningBalance())}
            </div>
            <Show when={account()?.lastReconciled}>
              {(lastReconciled) => (
                <div class="account-reconciled-info">Last reconciled: {lastReconciled()}</div>
              )}
            </Show>
          </div>
        </Show>

        <TransactionFilters
          accountId={accountId()}
          activeConditions={filterConditions()}
          activeConditionsOp={filterConditionsOp()}
          onConditionsChange={handleFilterChange}
        />

        <Show when={showImport()}>
          <ImportModal accountId={accountId()} onClose={() => setShowImport(false)} />
        </Show>

        <Show when={showReconcile()}>
          <ReconcileModal
            accountId={accountId()}
            runningBalance={runningBalance()}
            transactions={reconciliableTransactions()}
            onClose={() => {
              setShowReconcile(false);
            }}
            onFinish={() => {
              setShowReconcile(false);
              void loadAccount();
            }}
          />
        </Show>

        <Show
          when={transactions().length > 0}
          fallback={<div class="empty-state">No transactions yet.</div>}
        >
          <TransactionTable
            transactions={transactions()}
            categories={categories()}
            txTags={txTags()}
            tagList={tagList()}
            showBalance={filterConditions().length === 0 && !filterId()}
            openingBalance={account()?.openingBalance ?? 0}
            onReload={loadAccount}
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

function ImportModal(props: { accountId: string; onClose: () => void }) {
  const [file, setFile] = createSignal<File | null>(null);
  const [importing, setImporting] = createSignal(false);
  const [result, setResult] = createSignal<{ added: number; errors: string[] } | null>(null);

  async function handleImport() {
    const f = file();
    if (!f || importing()) return;
    setImporting(true);
    setResult(null);

    try {
      const parsed = parseCsv(await f.text());
      if (parsed.errors.length || parsed.rows.length === 0) {
        setResult({
          added: 0,
          errors: parsed.errors.length ? parsed.errors : ["No transactions found."],
        });
        return;
      }
      const result = await execute("import_transactions", {
        accountId: props.accountId,
        transactions: parsed.rows,
        isPreview: false,
      });
      if (result.ok) {
        setResult({ added: result.data.added ?? 0, errors: [...(result.data.errors ?? [])] });
        emitMoneyDataChanged();
      } else {
        setResult({ added: 0, errors: [result.error] });
      }
    } catch (err) {
      setResult({ added: 0, errors: [err instanceof Error ? err.message : "Import failed"] });
    } finally {
      setImporting(false);
    }
  }

  return (
    <MoneyDialog title="Import CSV" onClose={props.onClose} busy={importing()}>
      <div class="money-form">
        <input
          aria-label="CSV file"
          type="file"
          accept=".csv,.tsv"
          disabled={importing()}
          onChange={(e) => {
            setFile(e.currentTarget.files?.[0] ?? null);
            setResult(null);
          }}
        />
        <Show when={file()}>
          <p class="file-info">
            {file()?.name} ({((file()?.size ?? 0) / 1024).toFixed(1)} KB)
          </p>
        </Show>
        <Show when={result()}>
          <div class="import-result">
            <p role="status">Added: {result()?.added} transactions</p>
            <Show when={(result()?.errors.length ?? 0) > 0}>
              <ul role="alert">
                <For each={result()?.errors}>{(err) => <li>{err}</li>}</For>
              </ul>
            </Show>
          </div>
        </Show>
        <div class="form-actions">
          <button class="btn btn-ghost" onClick={props.onClose} disabled={importing()}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            onClick={handleImport}
            disabled={!file() || importing() || (result()?.added ?? 0) > 0}
          >
            {importing() ? "Importing..." : result()?.errors.length ? "Retry import" : "Import"}
          </button>
        </div>
      </div>
    </MoneyDialog>
  );
}

function ReconcileModal(props: {
  accountId: string;
  runningBalance: number;
  transactions: TransactionRow[];
  onClose: () => void;
  onFinish: () => void;
}) {
  const fmt = useCurrency();
  const [statementBalance, setStatementBalance] = createSignal("");
  const [processing, setProcessing] = createSignal(false);
  const [done, setDone] = createSignal(false);

  const handleClose = () => {
    setStatementBalance("");
    props.onClose();
  };

  const handleDone = () => {
    setStatementBalance("");
    props.onFinish();
  };

  const diff = createMemo(() => {
    const sb = fmt().parseInput(statementBalance() || "0");
    return sb - props.runningBalance;
  });

  const isBalanced = () => diff() === 0;

  async function handleFinish() {
    if (!Number.isSafeInteger(diff())) return;
    setProcessing(true);

    const now = new Date().toISOString();
    const promises: Promise<unknown>[] = [];

    for (const tx of props.transactions) {
      promises.push(
        dispatch("update_transaction", {
          id: tx.id,
          fields: { reconciled: true },
        }).promise,
      );
    }

    if (!isBalanced()) {
      promises.push(
        dispatch("create_transaction", {
          row: {
            accountId: props.accountId,
            date: now.slice(0, 10),
            amount: -diff(),
            payee: "Reconciliation Adjustment",
            notes: "Balance adjustment from reconciliation",
            cleared: true,
            reconciled: true,
          },
        }).promise,
      );
    }

    promises.push(
      dispatch("update_account", {
        id: props.accountId,
        lastReconciled: now,
      }).promise,
    );

    await Promise.all(promises);
    setProcessing(false);
    setDone(true);
  }

  return (
    <div class="modal-overlay" onClick={handleClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Reconcile Account</h2>
          <button class="modal-close" onClick={handleClose}>
            ✕
          </button>
        </div>

        <Show
          when={!done()}
          fallback={
            <div class="modal-body" style={{ "text-align": "center", padding: "24px" }}>
              <p style={{ "font-size": "1.1rem", "margin-bottom": "16px" }}>
                ✓ Reconciliation complete
              </p>
              <p style={{ color: "var(--text-secondary)" }}>
                {props.transactions.length} transactions marked as reconciled.
                {!isBalanced() ? " An adjustment transaction was created." : ""}
              </p>
              <div class="form-actions" style={{ "margin-top": "24px" }}>
                <button class="btn btn-primary" onClick={handleDone}>
                  Done
                </button>
              </div>
            </div>
          }
        >
          <div class="modal-body">
            <div class="reconcile-summary">
              <div class="reconcile-row">
                <span class="reconcile-label">Running balance:</span>
                <span class="reconcile-value">{fmt().formatCents(props.runningBalance)}</span>
              </div>
              <div class="reconcile-row">
                <span class="reconcile-label">Statement balance:</span>
                <input
                  type="text"
                  inputmode={fmt().inputMode}
                  class="reconcile-input"
                  placeholder="0"
                  value={statementBalance()}
                  onInput={(e) => setStatementBalance(e.currentTarget.value)}
                  autofocus
                />
              </div>
              <div
                class="reconcile-row reconcile-diff"
                classList={{
                  "reconcile-balanced": isBalanced(),
                  "reconcile-negative": diff() < 0,
                  "reconcile-positive": diff() > 0,
                }}
              >
                <span class="reconcile-label">Difference:</span>
                <span class="reconcile-value">
                  {Number.isSafeInteger(diff()) ? fmt().formatCents(diff()) : "—"}
                </span>
              </div>
            </div>

            <Show when={(props.transactions.length ?? 0) === 0}>
              <p style={{ color: "var(--text-muted)", "margin-top": "16px" }}>
                No cleared transactions to reconcile.
              </p>
            </Show>

            <Show when={!isBalanced() && statementBalance() !== ""}>
              <div class="reconcile-adjustment-note">
                {diff() > 0
                  ? "An adjustment transaction will credit the account."
                  : "An adjustment transaction will debit the account."}
              </div>
            </Show>
          </div>

          <div class="form-actions">
            <button class="btn btn-ghost" onClick={handleClose}>
              Cancel
            </button>
            <button
              class="btn btn-primary"
              onClick={handleFinish}
              disabled={processing() || statementBalance() === "" || !Number.isSafeInteger(diff())}
            >
              {processing() ? "Reconciling..." : "Finish Reconciliation"}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
