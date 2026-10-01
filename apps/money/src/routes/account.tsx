import { createSignal, createMemo, createEffect, For, onCleanup, onMount, Show } from "solid-js";
import { useParams, useNavigate, useSearchParams } from "@solidjs/router";
import { dispatch, requireCommandId } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import TransactionFilters from "../components/TransactionFilters";
import TransactionTable from "../components/TransactionTable";
import ActivityFeed from "../components/ActivityFeed";
import TransactionDrawer from "../components/TransactionDrawer";
import AccountTransferDialog from "../components/AccountTransferDialog";
import MoneyDialog from "../components/MoneyDialog";
import MoneyIcon from "../components/MoneyIcon";
import { PageState } from "../components/PageState";
import { useMoneyShell } from "../components/MoneyShellContext";
import { filterActivity } from "../lib/activity-view";
import CsvImportDialog from "../components/CsvImportDialog";
import CsvExportButton from "../components/CsvExportButton";
import { emitMoneyDataChanged, listenForMoneyDataChanged } from "../lib/data-events";
import type { TransactionRow } from "../components/TransactionTable";
import type { Condition } from "../components/TransactionFilters";
import type {
  AccountApi,
  AccountsResponse,
  AccountTransactionsResponse,
  CategoriesResponse,
  TagsResponse,
} from "../domain/schemas-client";

type LoadedAccount = {
  account: AccountApi;
  accounts: AccountsResponse["accounts"];
  transactions: AccountTransactionsResponse["transactions"];
  categories: CategoriesResponse["categories"];
  tags: TagsResponse["tags"];
  txTags: Record<string, { id: string; name: string; color: string | null }[]>;
  ledgerIds: Set<string> | null;
};

export default function AccountPage() {
  const params = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams<{ focus?: string }>();
  const navigate = useNavigate();
  const shell = useMoneyShell();
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const [loaded, setLoaded] = createSignal<LoadedAccount | null>(null);
  const data = () => (loaded()?.account.id === params.id ? loaded() : null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [managing, setManaging] = createSignal(false);
  const [ledger, setLedger] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [showImport, setShowImport] = createSignal(false);
  const [showReconcile, setShowReconcile] = createSignal(false);
  const [showTransfer, setShowTransfer] = createSignal(false);
  const [showRename, setShowRename] = createSignal(false);
  const [filterId, setFilterId] = createSignal<string | null>(null);
  const [filterConditions, setFilterConditions] = createSignal<Condition[]>([]);
  const [filterConditionsOp, setFilterConditionsOp] = createSignal<"and" | "or">("and");
  let requestId = 0;
  let previousId = params.id;
  createEffect(() => {
    if (previousId !== params.id) {
      previousId = params.id;
      setQuery("");
      setLedger(false);
      setFilterId(null);
      setFilterConditions([]);
      setActionError(null);
      setSearchParams({ focus: undefined }, { replace: true });
    }
    filterId();
    filterConditions();
    filterConditionsOp();
    void loadAccount();
  });
  onMount(() => onCleanup(listenForMoneyDataChanged(loadAccount)));
  onCleanup(() => {
    requestId++;
  });
  async function loadAccount() {
    const request = ++requestId;
    const id = params.id;
    const txQuery = filterId()
      ? { filterId: filterId()! }
      : filterConditions().length
        ? { conditions: filterConditions(), conditionsOp: filterConditionsOp() }
        : undefined;
    setLoading(true);
    setError(null);
    try {
      const [account, transactions, categories, accounts, tags, txTags, filtered] =
        await Promise.all([
          api.account(id),
          api.accountTransactions(id),
          api.categories(),
          api.accounts(),
          api.tags(),
          api.accountTags(id),
          txQuery ? api.accountTransactions(id, txQuery) : Promise.resolve(null),
        ]);
      if (request !== requestId || id !== params.id) return;
      const tagsById: LoadedAccount["txTags"] = {};
      for (const tag of txTags.transactionTags)
        (tagsById[tag.transactionId] ??= []).push({
          id: tag.tagId,
          name: tag.tagName,
          color: tag.tagColor,
        });
      setLoaded({
        account,
        accounts: accounts.accounts,
        transactions: transactions.transactions,
        categories: categories.categories,
        tags: tags.tags,
        txTags: tagsById,
        ledgerIds: filtered ? new Set(filtered.transactions.map((row) => row.id)) : null,
      });
    } catch (caught) {
      if (request === requestId)
        setError(caught instanceof Error ? caught.message : "Could not load account");
    } finally {
      if (request === requestId) setLoading(false);
    }
  }
  const rows = createMemo(() =>
    filterActivity(
      (data()?.transactions ?? []).map((row) => ({
        ...row,
        accountName: data()?.account.name,
        categoryName:
          data()?.categories.find((category) => category.id === row.categoryId)?.name ??
          row.categoryName ??
          null,
      })),
      { month: null, query: query() },
    ),
  );
  const ledgerRows = createMemo(() =>
    rows().filter((row) => !data()?.ledgerIds || data()?.ledgerIds?.has(row.id)),
  );
  const selected = createMemo(() =>
    data()?.transactions.find((row) => row.id === searchParams.focus),
  );
  const clearedBalance = createMemo(
    () =>
      (data()?.account.openingBalance ?? 0) +
      (data()?.transactions ?? [])
        .filter((row) => !row.isChild && row.cleared)
        .reduce((sum, row) => sum + row.amount, 0),
  );
  async function toggleClosed() {
    const account = data()?.account;
    if (!account || managing()) return;
    setManaging(true);
    setActionError(null);
    try {
      await dispatch(
        account.closed ? "reopen_account" : "close_account",
        { id: account.id },
        {
          undoInfo: {
            label: account.closed ? "Account reopened" : "Account closed",
            inverse: {
              commandType: account.closed ? "close_account" : "reopen_account",
              payload: { id: account.id },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      if (!account.closed) navigate("/accounts");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update account");
    } finally {
      setManaging(false);
    }
  }
  return (
    <div class="page account-detail-page" aria-busy={loading()}>
      <PageState loading={loading() && !data()} error={error()} onRetry={loadAccount}>
        <div class="page-header">
          <select
            class="account-name-picker"
            aria-label="Account"
            value={params.id}
            disabled={managing()}
            onChange={(event) => navigate(`/accounts/${event.currentTarget.value}`)}
          >
            <For each={data()?.accounts.filter((row) => !row.closed || row.id === params.id)}>
              {(account) => <option value={account.id}>{account.name}</option>}
            </For>
          </select>
          <details class="entity-menu">
            <summary aria-label="Account actions">
              <MoneyIcon name="more" />
            </summary>
            <div
              class="entity-menu-popover"
              onClick={() => {
                document
                  .querySelectorAll(".entity-menu[open]")
                  .forEach((menu) => menu.removeAttribute("open"));
              }}
            >
              <button
                onClick={() => {
                  setLedger(!ledger());
                  setSearchParams({ focus: undefined });
                }}
              >
                {ledger() ? "Activity" : "Ledger"}
              </button>
              <button onClick={() => setShowImport(true)} disabled={data()?.account.closed}>
                Import CSV
              </button>
              <CsvExportButton accountId={params.id} />
              <button onClick={() => setShowReconcile(true)} disabled={data()?.account.closed}>
                Reconcile
              </button>
              <button onClick={() => setShowRename(true)}>Rename</button>
              <button onClick={() => void toggleClosed()} disabled={managing()}>
                {data()?.account.closed ? "Reopen account" : "Close account"}
              </button>
            </div>
          </details>
        </div>
        <div class="account-overview">
          <strong class={privacy().blurClass()}>
            {fmt().formatCents(data()?.account.balanceCurrent ?? 0)}
          </strong>
          <div class="account-main-actions">
            <button
              class="btn btn-secondary"
              disabled={
                data()?.account.closed ||
                (data()?.accounts.filter((row) => !row.closed).length ?? 0) < 2
              }
              onClick={() => setShowTransfer(true)}
            >
              <MoneyIcon name="move" size={17} />
              Transfer
            </button>
            <button
              class="btn btn-primary"
              disabled={data()?.account.closed}
              onClick={() => shell.openTransaction({ initialAccountId: params.id })}
            >
              <MoneyIcon name="plus" size={17} />
              Add
            </button>
          </div>
        </div>
        <Show when={actionError()}>
          <p class="form-error" role="alert">
            {actionError()}
          </p>
        </Show>
        <div class="transaction-search">
          <MoneyIcon name="search" size={17} />
          <input
            type="search"
            aria-label="Search account activity"
            placeholder="Search activity"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <Show when={ledger()}>
          <div class="account-ledger-heading">
            <span>Ledger</span>
            <button class="text-button" onClick={() => setLedger(false)}>
              Activity
            </button>
          </div>
          <details class="activity-advanced">
            <summary>
              <MoneyIcon name="settings" size={16} />
              Filters
            </summary>
            <TransactionFilters
              accountId={params.id}
              activeConditions={filterConditions()}
              activeConditionsOp={filterConditionsOp()}
              onConditionsChange={(conditions, op, id) => {
                setFilterConditions(conditions);
                setFilterConditionsOp(op);
                setFilterId(id);
              }}
            />
          </details>
        </Show>
        <Show
          when={rows().length}
          fallback={
            <p class="quiet-empty">{query() ? "No matching transactions" : "No activity yet"}</p>
          }
        >
          <Show
            when={ledger()}
            fallback={
              <ActivityFeed
                transactions={rows()}
                categories={data()?.categories ?? []}
                hideAccount
                onSelect={(id) => setSearchParams({ focus: id })}
              />
            }
          >
            <TransactionTable
              transactions={ledgerRows().map(
                (row): TransactionRow => ({
                  ...row,
                  accountName: row.accountName ?? undefined,
                  categoryName: row.categoryName ?? null,
                }),
              )}
              categories={(data()?.categories ?? []).map((row) => ({
                id: row.id,
                name: row.name,
                groupName: row.group_name ?? null,
              }))}
              txTags={data()?.txTags ?? {}}
              tagList={[...(data()?.tags ?? [])]}
              showBalance={!filterId() && !filterConditions().length && !query()}
              openingBalance={data()?.account.openingBalance ?? 0}
              onReload={loadAccount}
              onTransactionRemove={() => void loadAccount()}
              onTransactionRestore={() => void loadAccount()}
              focusId={searchParams.focus}
              onTagAdd={() => void loadAccount()}
              onTagRemove={() => void loadAccount()}
              onCreateSchedule={(tx) => {
                void dispatch(
                  "create_schedule",
                  {
                    schedule: {
                      accountId: tx.accountId,
                      categoryId: tx.categoryId,
                      name: tx.payee ?? "Recurring payment",
                      amount: tx.amount,
                      recurrenceRules: JSON.stringify({ type: "monthly" }),
                      startDate: tx.date,
                      nextDate: tx.date,
                    },
                  },
                  {
                    undoInfo: {
                      label: "Recurring payment created",
                      inverse: (result) => ({
                        commandType: "delete_schedule",
                        payload: { id: requireCommandId(result) },
                      }),
                    },
                  },
                )
                  .promise.then(() => emitMoneyDataChanged())
                  .catch((caught) =>
                    setActionError(
                      caught instanceof Error ? caught.message : "Could not create payment",
                    ),
                  );
              }}
            />
          </Show>
        </Show>
      </PageState>
      <Show when={!ledger() && selected()?.id} keyed>
        {(id) => (
          <TransactionDrawer
            transaction={data()!.transactions.find((row) => row.id === id)!}
            categories={data()!.categories}
            accounts={data()!.accounts}
            children={data()!.transactions.filter((row) => row.parentId === id)}
            tags={data()?.txTags[id] ?? []}
            onClose={() => setSearchParams({ focus: undefined }, { replace: true })}
            onLedger={() => setLedger(true)}
          />
        )}
      </Show>
      <Show when={showTransfer() && data()}>
        <AccountTransferDialog
          accounts={data()!.accounts}
          fromAccountId={params.id}
          onClose={() => setShowTransfer(false)}
        />
      </Show>
      <Show when={showImport()}>
        <CsvImportDialog accountId={params.id} onClose={() => setShowImport(false)} />
      </Show>
      <Show when={showReconcile()}>
        <ReconcileModal
          accountId={params.id}
          runningBalance={clearedBalance()}
          onClose={() => setShowReconcile(false)}
        />
      </Show>
      <Show when={showRename() && data()?.account.id} keyed>
        {(id) => (
          <RenameAccount
            account={data()!.accounts.find((row) => row.id === id)!}
            onClose={() => setShowRename(false)}
          />
        )}
      </Show>
    </div>
  );
}

function RenameAccount(props: { account: AccountApi; onClose: () => void }) {
  const original = props.account;
  const [name, setName] = createSignal(original.name);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!name().trim() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "update_account",
        { id: original.id, name: name().trim() },
        {
          undoInfo: {
            label: "Account renamed",
            inverse: {
              commandType: "update_account",
              payload: { id: original.id, name: original.name },
            },
          },
        },
      ).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename account");
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog title="Rename account" busy={busy()} onClose={props.onClose}>
      <form class="money-form" onSubmit={save}>
        <div class="form-group">
          <label for="rename-account-name">Name</label>
          <input
            id="rename-account-name"
            value={name()}
            required
            disabled={busy()}
            onInput={(event) => setName(event.currentTarget.value)}
            autofocus
          />
        </div>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <button class="btn btn-primary btn-full" disabled={busy()}>
          Save
        </button>
      </form>
    </MoneyDialog>
  );
}
function ReconcileModal(props: { accountId: string; runningBalance: number; onClose: () => void }) {
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const [statement, setStatement] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const difference = createMemo(() => fmt().parseInput(statement()) - props.runningBalance);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const amount = fmt().parseInput(statement());
    if (
      !statement().trim() ||
      !Number.isSafeInteger(amount) ||
      !Number.isSafeInteger(difference()) ||
      busy()
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await dispatch("reconcile_account", {
        accountId: props.accountId,
        expectedBalance: props.runningBalance,
        statementBalance: amount,
      }).promise;
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reconcile account");
      emitMoneyDataChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog title="Reconcile" busy={busy()} onClose={props.onClose}>
      <form class="money-form" onSubmit={save}>
        <div class="reconcile-balance">
          <span>Cleared balance</span>
          <strong class={privacy().blurClass()}>{fmt().formatCents(props.runningBalance)}</strong>
        </div>
        <div class="form-group">
          <label for="statement-balance">Statement balance</label>
          <input
            id="statement-balance"
            type="text"
            inputmode={fmt().inputMode}
            value={statement()}
            onInput={(event) => setStatement(event.currentTarget.value)}
            disabled={busy()}
            autofocus
            required
          />
        </div>
        <Show when={statement().trim() && Number.isSafeInteger(difference())}>
          <div class="reconcile-balance">
            <span>{difference() === 0 ? "Matched" : "Adjustment"}</span>
            <strong class={privacy().blurClass()}>
              {difference() === 0 ? <MoneyIcon name="check" /> : fmt().formatCents(difference())}
            </strong>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <button
          class="btn btn-primary btn-full"
          disabled={busy() || !statement().trim() || !Number.isSafeInteger(difference())}
        >
          {busy() ? "Reconciling…" : "Reconcile"}
        </button>
      </form>
    </MoneyDialog>
  );
}
