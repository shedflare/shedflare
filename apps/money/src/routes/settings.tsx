import { createEffect, createResource, createSignal, Show } from "solid-js";
import * as Schema from "effect/Schema";
import { api } from "../lib/api";
import { loadRequest, requestValue, requestError } from "../lib/request-state";
import { applySettings, setSetting } from "../lib/settings-store";
import { dispatch } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { formatCentsValue } from "../lib/currency";
import { resolveNumberFormat } from "../domain/money-amount";
import MoneyIcon from "../components/MoneyIcon";
import CsvImportDialog from "../components/CsvImportDialog";
import CsvExportButton from "../components/CsvExportButton";
import { PageState } from "../components/PageState";

const PreferencesSchema = Schema.Struct({
  display_currency: Schema.Literals(["USD", "IDR"]),
  number_format: Schema.Literals(["auto", "comma-dot", "dot-comma", "space-dot"]),
  privacy_mode: Schema.Literals(["true", "false"]),
  date_format: Schema.Literals(["iso", "us", "eu"]),
  hide_closed_accounts: Schema.Literals(["true", "false"]),
});
type Preferences = Schema.Schema.Type<typeof PreferencesSchema>;
const defaults: Preferences = {
  display_currency: "USD",
  number_format: "auto",
  privacy_mode: "false",
  date_format: "iso",
  hide_closed_accounts: "false",
};
type Change = { key: keyof Preferences; value: string };
type SaveState =
  | { state: "idle" }
  | { state: "saving"; change: Change }
  | { state: "failed"; change: Change; message: string };
export default function SettingsPage() {
  const [result, { refetch }] = createResource(() =>
    loadRequest(async () => {
      const response = await api.settings();
      applySettings(response);
      return response;
    }),
  );
  const data = () => requestValue(result());
  const [draft, setDraft] = createSignal<Preferences>(defaults);
  const [saveState, setSaveState] = createSignal<SaveState>({ state: "idle" });
  const [importing, setImporting] = createSignal(false);
  createEffect(() => {
    const response = data();
    if (!response) return;
    const values = { ...defaults };
    for (const key of [
      "display_currency",
      "number_format",
      "privacy_mode",
      "date_format",
      "hide_closed_accounts",
    ] as const) {
      const value = response.settings.find((row) => row.key === key)?.value;
      if (value && Schema.is(PreferencesSchema.fields[key])(value))
        Object.assign(values, { [key]: value });
    }
    setDraft(values);
  });
  function disabled() {
    return saveState().state !== "idle";
  }
  async function save(change: Change) {
    if (saveState().state === "saving") return;
    const next = Schema.decodeUnknownSync(PreferencesSchema)({
      ...draft(),
      [change.key]: change.value,
    });
    setDraft(next);
    setSaveState({ state: "saving", change });
    try {
      await dispatch("update_setting", change).promise;
      setSetting(change.key, change.value);
      setSaveState({ state: "idle" });
      emitMoneyDataChanged();
    } catch (caught) {
      setSaveState({
        state: "failed",
        change,
        message: caught instanceof Error ? caught.message : "Could not save preference",
      });
    }
  }
  async function discard() {
    setSaveState({
      state: "saving",
      change: { key: "display_currency", value: draft().display_currency },
    });
    await refetch();
    setSaveState({ state: "idle" });
  }
  const preview = () =>
    formatCentsValue(
      draft().display_currency === "IDR" ? 125_000_000 : 125_000,
      draft().display_currency,
      resolveNumberFormat(draft().display_currency, draft().number_format),
    );
  return (
    <div class="page money-preferences-page">
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
      </div>
      <PageState
        loading={result.loading && !data()}
        error={requestError(result())}
        onRetry={() => void refetch()}
      >
        <div class="money-preferences">
          <div
            class="preference-preview"
            classList={{ "privacy-blur": draft().privacy_mode === "true" }}
          >
            {preview()}
          </div>
          <div class="preference-list">
            <div class="preference-row">
              <label for="money-currency">Currency</label>
              <select
                id="money-currency"
                value={draft().display_currency}
                disabled={disabled()}
                onChange={(event) =>
                  void save({ key: "display_currency", value: event.currentTarget.value })
                }
              >
                <option value="USD">US dollar ($)</option>
                <option value="IDR">Indonesian rupiah (Rp)</option>
              </select>
            </div>
            <div class="preference-row">
              <label for="money-number-format">Number format</label>
              <select
                id="money-number-format"
                value={draft().number_format}
                disabled={disabled()}
                onChange={(event) =>
                  void save({ key: "number_format", value: event.currentTarget.value })
                }
              >
                <option value="auto">Automatic</option>
                <option value="comma-dot">1,234.56</option>
                <option value="dot-comma">1.234,56</option>
                <option value="space-dot">1 234.56</option>
              </select>
            </div>
            <div class="preference-row">
              <label for="money-privacy">Hide amounts</label>
              <label class="preference-switch-hit" for="money-privacy">
                <input
                  id="money-privacy"
                  class="preference-switch"
                  type="checkbox"
                  role="switch"
                  checked={draft().privacy_mode === "true"}
                  disabled={disabled()}
                  onChange={(event) =>
                    void save({ key: "privacy_mode", value: String(event.currentTarget.checked) })
                  }
                />
              </label>
            </div>
          </div>
          <Show when={saveState().state === "failed"}>
            <div class="preference-error" role="alert">
              <span>
                {(() => {
                  const state = saveState();
                  return state.state === "failed" ? state.message : "";
                })()}
              </span>
              <div>
                <button
                  class="text-button"
                  onClick={() => {
                    const state = saveState();
                    if (state.state === "failed") void save(state.change);
                  }}
                >
                  Retry
                </button>
                <button class="text-button" onClick={() => void discard()}>
                  Reload
                </button>
              </div>
            </div>
          </Show>
          <details class="preference-advanced">
            <summary>
              More preferences
              <MoneyIcon name="chevron" size={16} />
            </summary>
            <div class="preference-list">
              <div class="preference-row">
                <label for="money-date-format">Date format</label>
                <select
                  id="money-date-format"
                  value={draft().date_format}
                  disabled={disabled()}
                  onChange={(event) =>
                    void save({ key: "date_format", value: event.currentTarget.value })
                  }
                >
                  <option value="iso">2026-10-01</option>
                  <option value="us">10/01/2026</option>
                  <option value="eu">01/10/2026</option>
                </select>
              </div>
              <div class="preference-row">
                <label for="money-hide-closed">Hide closed accounts</label>
                <label class="preference-switch-hit" for="money-hide-closed">
                  <input
                    id="money-hide-closed"
                    class="preference-switch"
                    type="checkbox"
                    role="switch"
                    checked={draft().hide_closed_accounts === "true"}
                    disabled={disabled()}
                    onChange={(event) =>
                      void save({
                        key: "hide_closed_accounts",
                        value: String(event.currentTarget.checked),
                      })
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <div class="preference-export">
            <div>
              <MoneyIcon name="activity" size={20} />
              <span>Transactions</span>
            </div>
            <div class="csv-settings-actions">
              <button class="btn btn-secondary" onClick={() => setImporting(true)}>
                Import CSV
              </button>
              <CsvExportButton />
            </div>
          </div>
        </div>
      </PageState>
      <Show when={importing()}>
        <CsvImportDialog onClose={() => setImporting(false)} />
      </Show>
    </div>
  );
}
