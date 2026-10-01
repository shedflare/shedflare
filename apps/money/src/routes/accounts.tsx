/**
 * Accounts page — list of all accounts with balances.
 */
import { createSignal, createMemo, For, Show, createEffect, onCleanup, onMount } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { dispatch } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { settingsCollection } from "../lib/collections";
import { PageState } from "../components/PageState";
import { useAccountForm } from "../lib/forms/accounts";
import { listenForMoneyDataChanged } from "../lib/data-events";
import MoneyDialog from "../components/MoneyDialog";
import MoneyIcon from "../components/MoneyIcon";

interface AccountRow {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
  balanceCurrent: number | null;
  sortOrder: number;
}

export default function AccountsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams<{ new?: string }>();
  const fmt = useCurrency();
  const privacyBlur = usePrivacyMode();
  const [accounts, setAccounts] = createSignal<AccountRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [showAddForm, setShowAddForm] = createSignal(params.new === "1");
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [hideClosed, setHideClosed] = createSignal(false);

  const { values, errors, setValues, validate, resetForm } = useAccountForm();

  createEffect(() => {
    function sync() {
      const hc = settingsCollection.state.get("hide_closed_accounts")?.value;
      setHideClosed(hc === "true");
    }
    sync();
    const unsub = settingsCollection.subscribeChanges(sync);
    onCleanup(() => unsub.unsubscribe());
  });

  createEffect(() => {
    void loadAccounts();
  });

  onMount(() => {
    onCleanup(listenForMoneyDataChanged(loadAccounts));
  });

  async function loadAccounts() {
    setError(null);
    try {
      const data = await api.accounts();
      setAccounts([...data.accounts]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!validate()) return;

    const name = values.name.trim();
    const balance = values.balance ? fmt().parseInput(values.balance) : undefined;
    if (balance !== undefined && !Number.isSafeInteger(balance)) {
      setSaveError("Enter a valid balance.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await dispatch("create_account", { name, offBudget: values.offbudget, balance }).promise;
      setShowAddForm(false);
      setParams({ new: undefined });
      resetForm();
      await loadAccounts();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not create account");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAccount(account: AccountRow) {
    if (!confirm(`Delete ${account.name}? This will also delete its transactions.`)) return;
    try {
      await dispatch("delete_account", { id: account.id }).promise;
    } finally {
      await loadAccounts();
    }
  }

  async function handleAccountClosed(account: AccountRow, closed: boolean) {
    const commandType = closed ? "close_account" : "reopen_account";
    const inverseType = closed ? "reopen_account" : "close_account";
    await dispatch(
      commandType,
      { id: account.id },
      {
        undoInfo: {
          label: closed ? "Close account" : "Reopen account",
          inverse: { commandType: inverseType, payload: { id: account.id } },
        },
      },
    ).promise;
    await loadAccounts();
  }

  function formatBalance(balance: number | null): string {
    if (balance === null) return "—";
    return fmt().formatCents(balance);
  }

  // Separate on-budget and off-budget accounts
  const onBudgetAccounts = createMemo(() => accounts().filter((a) => !a.offbudget && !a.closed));
  const offBudgetAccounts = createMemo(() => accounts().filter((a) => a.offbudget && !a.closed));
  const allClosedAccounts = createMemo(() => accounts().filter((a) => a.closed));
  const closedAccounts = createMemo(() => (hideClosed() ? [] : allClosedAccounts()));

  return (
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button
          class="btn btn-primary"
          onClick={() => {
            setSaveError(null);
            setShowAddForm(true);
          }}
        >
          <MoneyIcon name="plus" />
          Account
        </button>
      </div>

      <Show when={hideClosed() && allClosedAccounts().length > 0}>
        <div class="section" style={{ "margin-bottom": "8px" }}>
          <p style={{ "font-size": "0.8rem", color: "var(--text-muted)" }}>
            {allClosedAccounts().length} closed account{allClosedAccounts().length !== 1 ? "s" : ""}{" "}
            hidden (configure in Settings)
          </p>
        </div>
      </Show>

      <Show when={showAddForm()}>
        <MoneyDialog
          title="New account"
          onClose={() => {
            setShowAddForm(false);
            setParams({ new: undefined });
          }}
          busy={saving()}
        >
          <form class="money-form" onSubmit={handleSubmit}>
            <div class="form-group">
              <label for="account-name">Name</label>
              <input
                id="account-name"
                autofocus
                disabled={saving()}
                type="text"
                placeholder="e.g. Checking, Savings, Credit Card"
                value={values.name}
                onInput={(e) => setValues("name", e.currentTarget.value)}
                class={errors.name ? "input-error" : ""}
              />
              {errors.name && <span class="error-message">{errors.name.message}</span>}
            </div>
            <div class="form-group">
              <label for="account-balance">Starting balance</label>
              <input
                id="account-balance"
                disabled={saving()}
                type="text"
                inputmode={fmt().inputMode}
                placeholder={fmt().code === "IDR" ? "0" : "0.00"}
                value={values.balance || ""}
                onInput={(e) => setValues("balance", e.currentTarget.value)}
              />
            </div>
            <div class="form-check">
              <input
                type="checkbox"
                id="off-budget"
                checked={values.offbudget}
                disabled={saving()}
                onChange={(e) => setValues("offbudget", e.currentTarget.checked)}
              />
              <label for="off-budget">Keep outside the budget</label>
            </div>
            <Show when={saveError()}>
              <p class="form-error" role="alert">
                {saveError()}
              </p>
            </Show>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary btn-full" disabled={saving()}>
                {saving() ? "Creating…" : "Add account"}
              </button>
            </div>
          </form>
        </MoneyDialog>
      </Show>

      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadAccounts}
        loadingMessage="Loading accounts..."
      >
        <Show
          when={
            onBudgetAccounts().length > 0 ||
            offBudgetAccounts().length > 0 ||
            closedAccounts().length > 0
          }
          fallback={
            <div class="first-step">
              <MoneyIcon name="accounts" size={36} />
              <h2>Start with your everyday account.</h2>
              <button class="btn btn-primary" onClick={() => setShowAddForm(true)}>
                Add account
              </button>
            </div>
          }
        >
          <div class="accounts-summary">
            <span class="metric-label">Total balance</span>
            <strong class={privacyBlur().blurClass()}>
              {fmt().formatCents(
                accounts()
                  .filter((account) => !account.closed)
                  .reduce((sum, account) => sum + (account.balanceCurrent ?? 0), 0),
              )}
            </strong>
          </div>
          <RenderAccountGroup
            title="In your budget"
            accounts={onBudgetAccounts()}
            navigate={navigate}
            formatBalance={formatBalance}
            onDelete={handleDeleteAccount}
            onClosedChange={handleAccountClosed}
            blurClass={privacyBlur().blurClass()}
          />
          <RenderAccountGroup
            title="Outside your budget"
            accounts={offBudgetAccounts()}
            navigate={navigate}
            formatBalance={formatBalance}
            onDelete={handleDeleteAccount}
            onClosedChange={handleAccountClosed}
            blurClass={privacyBlur().blurClass()}
          />
          <RenderAccountGroup
            title="Closed"
            accounts={closedAccounts()}
            navigate={navigate}
            formatBalance={formatBalance}
            onDelete={handleDeleteAccount}
            onClosedChange={handleAccountClosed}
            blurClass={privacyBlur().blurClass()}
          />
        </Show>
      </PageState>
    </div>
  );
}

function RenderAccountGroup(props: {
  title: string;
  accounts: AccountRow[];
  navigate: (path: string) => void;
  formatBalance: (b: number | null) => string;
  onDelete: (account: AccountRow) => void;
  onClosedChange: (account: AccountRow, closed: boolean) => void;
  blurClass?: string;
}) {
  return (
    <Show when={props.accounts.length > 0}>
      <div class="section">
        <h2 class="section-title">{props.title}</h2>
        <div class="account-list">
          <For each={props.accounts}>
            {(account) => (
              <div class="account-card">
                <button
                  type="button"
                  class="account-card-main"
                  onClick={() => props.navigate(`/accounts/${account.id}`)}
                >
                  <div class="account-info">
                    <div class="account-name">{account.name}</div>
                    <span class="account-card-hint">Open ledger</span>
                  </div>
                  <div class={`account-balance ${props.blurClass ?? ""}`}>
                    {props.formatBalance(account.balanceCurrent)}
                  </div>
                </button>
                <details class="entity-menu">
                  <summary aria-label={`Actions for ${account.name}`}>•••</summary>
                  <div class="entity-menu-popover">
                    <button
                      type="button"
                      onClick={() => props.onClosedChange(account, !account.closed)}
                    >
                      {account.closed ? "Reopen account" : "Close account"}
                    </button>
                    <Show when={account.closed}>
                      <button type="button" class="danger" onClick={() => props.onDelete(account)}>
                        Delete permanently
                      </button>
                    </Show>
                  </div>
                </details>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
