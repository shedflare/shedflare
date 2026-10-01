import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import { PageState } from "./PageState";
import { api, execute } from "../lib/api";
import type { CommandPayloadMap } from "../domain/commands";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { emitMoneyDataChanged } from "../lib/data-events";
import { emitOperationFeedback } from "../lib/operation-feedback";
import { push, undo, undoStack, historyBusy } from "../lib/undo-stack";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { useDateFormat } from "../lib/date-format";
import {
  parseCsv,
  duplicateRows,
  CSV_IMPORT_MAX_ROWS,
  type CsvFieldMap,
} from "../domain/csv-import";
import type { NumberFormat } from "../domain/money-amount";

type ImportPayload = CommandPayloadMap["import_transactions"];
type ImportResult = { id: string; added: number; skipped: number };
const columns = [
  ["date", "Date"],
  ["amount", "Amount"],
  ["in", "Money in"],
  ["out", "Money out"],
  ["payee", "Payee"],
  ["description", "Description"],
  ["notes", "Notes"],
  ["category", "Category"],
  ["account", "Account"],
] as const;
export default function CsvImportDialog(props: { accountId?: string; onClose: () => void }) {
  const fmt = useCurrency(),
    privacy = usePrivacyMode(),
    df = useDateFormat();
  const [loaded, { refetch }] = createResource(() =>
    loadRequest(async () => {
      const [accounts, categories] = await Promise.all([api.accounts(), api.categories()]);
      return { accounts: accounts.accounts, categories: categories.categories };
    }),
  );
  const data = () => requestValue(loaded());
  const [accountId, setAccountId] = createSignal(props.accountId ?? "");
  createEffect(() => {
    if (!accountId() && data())
      setAccountId(data()?.accounts.find((account) => !account.closed)?.id ?? "");
  });
  const [existing, { refetch: refreshExisting }] = createResource(accountId, (id) =>
    loadRequest(() => api.accountTransactions(id)),
  );
  const account = createMemo(() => data()?.accounts.find((row) => row.id === accountId()));
  const [text, setText] = createSignal("");
  const [fileName, setFileName] = createSignal("");
  const [mapping, setMapping] = createSignal<CsvFieldMap | undefined>();
  const [numbers, setNumbers] = createSignal<NumberFormat | "auto">("auto");
  const [dates, setDates] = createSignal<"dmy" | "mdy">(df().format === "us" ? "mdy" : "dmy");
  const [sourceAccount, setSourceAccount] = createSignal("");
  const [skipDuplicates, setSkipDuplicates] = createSignal(true);
  const [reading, setReading] = createSignal(false),
    [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null),
    [result, setResult] = createSignal<ImportResult | null>(null);
  const [attempt, setAttempt] = createSignal<ImportPayload | null>(null);
  const frozen = () => busy() || attempt() !== null;
  const parsed = createMemo(() => {
    const format = numbers();
    return parseCsv(text(), mapping(), {
      currency: fmt().code,
      numberFormat: format === "auto" ? undefined : format,
      dateFormat: dates(),
    });
  });
  const sourceAccounts = createMemo(() => [
    ...new Set(
      parsed()
        .rows.map((row) => row.account)
        .filter((name): name is string => !!name),
    ),
  ]);
  createEffect(() => {
    const sources = sourceAccounts();
    if (!sources.includes(sourceAccount()))
      setSourceAccount(sources.find((name) => name === account()?.name) ?? sources[0] ?? "");
  });
  const rows = createMemo(() =>
    sourceAccounts().length > 1
      ? parsed().rows.filter((row) => row.account === sourceAccount())
      : parsed().rows,
  );
  const duplicates = createMemo(() =>
    duplicateRows(
      rows(),
      requestValue(existing())?.transactions.filter((row) => !row.isChild) ?? [],
    ),
  );
  const count = () => rows().length - (skipDuplicates() ? duplicates().size : 0);
  const canImport = () =>
    !busy() &&
    !reading() &&
    !existing.loading &&
    !account()?.closed &&
    !!account() &&
    !!requestValue(existing()) &&
    !requestError(existing()) &&
    !parsed().errors.length &&
    rows().length > 0 &&
    rows().length <= CSV_IMPORT_MAX_ROWS;
  async function readFile(file?: File) {
    if (!file) return;
    setError(null);
    setResult(null);
    setAttempt(null);
    setFileName(file.name);
    setText("");
    setMapping(undefined);
    setReading(true);
    try {
      if (file.size > 2_000_000) throw Error("Choose a CSV smaller than 2 MB");
      setText(await file.text());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read file");
    } finally {
      setReading(false);
    }
  }
  function setColumn(key: keyof CsvFieldMap, value: string) {
    setMapping({ ...parsed().detectedFields, [key]: value });
  }
  async function save() {
    if (!canImport()) return;
    setBusy(true);
    setError(null);
    const payload = attempt() ?? {
      accountId: accountId(),
      transactions: rows(),
      requestId: crypto.randomUUID(),
      skipDuplicates: skipDuplicates(),
    };
    setAttempt(payload);
    try {
      const response = await execute("import_transactions", payload);
      if (!response.ok) throw Error(response.error);
      if (
        !response.data.id ||
        response.data.added === undefined ||
        response.data.skipped === undefined
      )
        throw Error("Could not confirm the import. Retry to check it.");
      const saved = {
        id: response.data.id,
        added: response.data.added,
        skipped: response.data.skipped,
      };
      if (saved.added)
        push(
          "Import CSV",
          { commandType: "import_transactions", payload },
          { commandType: "undo_transaction_import", payload: { id: saved.id } },
        );
      setResult(saved);
      emitMoneyDataChanged();
      emitOperationFeedback({
        kind: "success",
        message: saved.added + " transactions imported",
        undoable: saved.added > 0,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import transactions");
    } finally {
      setBusy(false);
    }
  }
  const canUndo = () => {
    const latest = undoStack().at(-1);
    return (
      !historyBusy() &&
      latest?.inverse.commandType === "undo_transaction_import" &&
      "id" in latest.inverse.payload &&
      latest.inverse.payload.id === result()?.id
    );
  };
  return (
    <MoneyDialog title="Import CSV" onClose={props.onClose} busy={busy() || reading()}>
      <div class="money-form csv-import-form">
        <PageState
          loading={loaded.loading && !data()}
          error={requestError(loaded())}
          onRetry={() => void refetch()}
        >
          <Show
            when={!result()}
            fallback={
              <div class="csv-import-complete">
                <MoneyIcon name="check" size={32} />
                <strong role="status">{result()?.added} transactions imported</strong>
                <Show when={result()?.skipped}>
                  <span>{result()?.skipped} already in this account</span>
                </Show>
                <div class="form-actions">
                  <Show when={result()?.added}>
                    <button
                      class="btn btn-secondary"
                      disabled={!canUndo()}
                      onClick={async () => {
                        if (await undo()) props.onClose();
                      }}
                    >
                      Undo import
                    </button>
                  </Show>
                  <button class="btn btn-primary" onClick={props.onClose}>
                    Done
                  </button>
                </div>
              </div>
            }
          >
            <Show
              when={props.accountId}
              fallback={
                <div class="form-group">
                  <label for="csv-account">Account</label>
                  <select
                    id="csv-account"
                    disabled={frozen()}
                    value={accountId()}
                    onChange={(event) => setAccountId(event.currentTarget.value)}
                  >
                    <For each={data()?.accounts.filter((row) => !row.closed)}>
                      {(row) => <option value={row.id}>{row.name}</option>}
                    </For>
                  </select>
                </div>
              }
            >
              <span class="csv-import-account">{account()?.name}</span>
            </Show>
            <Show
              when={data()?.accounts.some((row) => !row.closed)}
              fallback={<p class="form-error">Add an account before importing.</p>}
            >
              <label class="csv-file-picker">
                <MoneyIcon name="activity" size={22} />
                <strong>{fileName() || "Choose CSV"}</strong>
                <input
                  aria-label="CSV file"
                  type="file"
                  accept=".csv,.tsv,text/csv,text/tab-separated-values"
                  disabled={frozen() || reading()}
                  onChange={(event) => void readFile(event.currentTarget.files?.[0])}
                />
              </label>
            </Show>
            <Show when={reading()}>
              <span role="status">Reading…</span>
            </Show>
            <Show when={text()}>
              <details class="csv-columns" open={parsed().errors.length > 0}>
                <summary>
                  Columns &amp; format
                  <MoneyIcon name="chevron" size={16} />
                </summary>
                <div class="csv-column-grid">
                  <For each={columns}>
                    {([key, label]) => (
                      <div class="form-group">
                        <label for={"csv-column-" + key}>{label}</label>
                        <select
                          id={"csv-column-" + key}
                          value={parsed().detectedFields[key] ?? ""}
                          disabled={frozen()}
                          onChange={(event) => setColumn(key, event.currentTarget.value)}
                        >
                          <option value="">—</option>
                          <For each={parsed().headers}>
                            {(header) => <option value={header}>{header}</option>}
                          </For>
                        </select>
                      </div>
                    )}
                  </For>
                  <div class="form-group">
                    <label for="csv-dates">Dates</label>
                    <select
                      id="csv-dates"
                      value={dates()}
                      disabled={frozen()}
                      onChange={(event) =>
                        setDates(event.currentTarget.value === "mdy" ? "mdy" : "dmy")
                      }
                    >
                      <option value="dmy">Day / month / year</option>
                      <option value="mdy">Month / day / year</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label for="csv-numbers">Numbers</label>
                    <select
                      id="csv-numbers"
                      value={numbers()}
                      disabled={frozen()}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (
                          value === "auto" ||
                          value === "comma-dot" ||
                          value === "dot-comma" ||
                          value === "space-dot"
                        )
                          setNumbers(value);
                      }}
                    >
                      <option value="auto">Automatic</option>
                      <option value="comma-dot">1,234.56</option>
                      <option value="dot-comma">1.234,56</option>
                      <option value="space-dot">1 234.56</option>
                    </select>
                  </div>
                </div>
              </details>
              <Show when={sourceAccounts().length > 1}>
                <div class="form-group">
                  <label for="csv-source">From file account</label>
                  <select
                    id="csv-source"
                    disabled={frozen()}
                    value={sourceAccount()}
                    onChange={(event) => setSourceAccount(event.currentTarget.value)}
                  >
                    <For each={sourceAccounts()}>
                      {(name) => <option value={name}>{name}</option>}
                    </For>
                  </select>
                </div>
              </Show>
              <Show when={parsed().errors.length}>
                <ul class="csv-errors" role="alert">
                  <For each={parsed().errors.slice(0, 5)}>{(message) => <li>{message}</li>}</For>
                  <Show when={parsed().errors.length > 5}>
                    <li>+{parsed().errors.length - 5} more</li>
                  </Show>
                </ul>
              </Show>
              <Show when={rows().length > CSV_IMPORT_MAX_ROWS}>
                <p class="form-error" role="alert">
                  Import up to {CSV_IMPORT_MAX_ROWS} transactions at a time.
                </p>
              </Show>
              <Show when={!parsed().errors.length && !rows().length}>
                <p class="form-error" role="alert">
                  No transactions found.
                </p>
              </Show>
              <Show when={requestError(existing())}>
                <div class="csv-read-error" role="alert">
                  <span>Could not check existing transactions.</span>
                  <button class="text-button" onClick={() => void refreshExisting()}>
                    Retry check
                  </button>
                </div>
              </Show>
              <Show when={rows().length && !parsed().errors.length}>
                <div class="csv-review-heading">
                  <strong>{count()} to import</strong>
                  <Show when={duplicates().size}>
                    <label>
                      <input
                        type="checkbox"
                        checked={skipDuplicates()}
                        disabled={frozen()}
                        onChange={(event) => setSkipDuplicates(event.currentTarget.checked)}
                      />
                      Skip {duplicates().size} possible duplicate
                      {duplicates().size === 1 ? "" : "s"}
                    </label>
                  </Show>
                </div>
                <div class="csv-preview" aria-label="Transaction preview">
                  <For each={rows().slice(0, 8)}>
                    {(row, index) => (
                      <div
                        class="csv-preview-row"
                        classList={{ "is-skipped": skipDuplicates() && duplicates().has(index()) }}
                      >
                        <span class="csv-preview-description">
                          <strong>{row.payee || "Uncategorized"}</strong>
                          <span>
                            {df().formatDate(row.date)}
                            <Show when={row.category}>
                              {" "}
                              ·{" "}
                              {data()?.categories.filter(
                                (category) =>
                                  category.name.toLocaleLowerCase() ===
                                  row.category?.toLocaleLowerCase(),
                              ).length === 1
                                ? row.category
                                : "Uncategorized"}
                            </Show>
                          </span>
                          <Show when={row.notes}>
                            <small>{row.notes}</small>
                          </Show>
                        </span>
                        <span class={privacy().blurClass()}>
                          <strong classList={{ "text-positive": row.amount > 0 }}>
                            {row.amount > 0 ? "+" : ""}
                            {fmt().formatCents(row.amount)}
                          </strong>
                          <Show when={duplicates().has(index())}>
                            <small>Possible duplicate</small>
                          </Show>
                        </span>
                      </div>
                    )}
                  </For>
                  <Show when={rows().length > 8}>
                    <span class="csv-preview-more">+{rows().length - 8} more</span>
                  </Show>
                </div>
              </Show>
            </Show>
            <Show when={error()}>
              <p class="form-error" role="alert">
                {error()}
              </p>
            </Show>
            <div class="form-actions">
              <button class="btn btn-ghost" disabled={busy() || reading()} onClick={props.onClose}>
                Cancel
              </button>
              <button class="btn btn-primary" disabled={!canImport()} onClick={() => void save()}>
                {busy() ? "Importing…" : attempt() ? "Retry import" : "Import"}
              </button>
            </div>
          </Show>
        </PageState>
      </div>
    </MoneyDialog>
  );
}
