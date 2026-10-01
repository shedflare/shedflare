/**
 * Settings page — currency, budget type, exchange rate, export, privacy, display.
 */
import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { dispatch } from "../lib/pending-ops";
import { api } from "../lib/api";
import { settingsCollection } from "../lib/collections";
import { loadSettings as loadSettingsStore, setSetting } from "../lib/settings-store";
import { usePrivacyMode } from "../lib/privacy";
import { PageState } from "../components/PageState";
import * as Schema from "effect/Schema";

type BudgetType = "envelope" | "tracking";
import type { CurrencyCode as Currency, NumberFormat } from "../domain/money-amount";
type DateFormat = "iso" | "us" | "eu";
type NumberFormatPreference = NumberFormat | "auto";
const CurrencySchema = Schema.Literals(["USD", "IDR"]);
const DateFormatSchema = Schema.Literals(["iso", "us", "eu"]);
const FirstDaySchema = Schema.Literals(["sunday", "monday"]);
const NumberFormatSchema = Schema.Literals(["auto", "comma-dot", "dot-comma", "space-dot"]);

export default function SettingsPage() {
  const [exchangeRate, setExchangeRate] = createSignal(16000);
  const [budgetType, setBudgetType] = createSignal<BudgetType>("envelope");
  const [currency, setCurrency] = createSignal<Currency>("USD");
  const [numberFormat, setNumberFormat] = createSignal<NumberFormatPreference>("auto");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const privacy = usePrivacyMode();
  type DisplaySetting = { key: "display_currency" | "number_format"; value: string };
  const [displaySave, setDisplaySave] = createSignal<
    | { state: "idle" }
    | ({ state: "saving" } & DisplaySetting)
    | ({ state: "failed"; message: string } & DisplaySetting)
  >({ state: "idle" });
  async function saveDisplaySetting(setting: DisplaySetting) {
    setDisplaySave({ state: "saving", ...setting });
    try {
      await dispatch("update_setting", setting).promise;
      setDisplaySave({ state: "idle" });
      setSetting(setting.key, setting.value);
    } catch (caught) {
      setDisplaySave({
        state: "failed",
        ...setting,
        message: caught instanceof Error ? caught.message : "Could not save setting.",
      });
    }
  }

  const [dateFormat, setDateFormat] = createSignal<DateFormat>("iso");
  const [hideClosed, setHideClosed] = createSignal(false);
  const [firstDayOfWeek, setFirstDayOfWeek] = createSignal<"sunday" | "monday">("sunday");

  createEffect(() => {
    setLoading(true);
    void loadPageData();
  });

  createEffect(() => {
    syncPersistedSettings();
    const unsub = settingsCollection.subscribeChanges(syncPersistedSettings);
    onCleanup(() => unsub.unsubscribe());
  });

  function syncPersistedSettings() {
    const budgetTypeSetting = settingsCollection.state.get("budget_type")?.value;
    if (budgetTypeSetting === "envelope" || budgetTypeSetting === "tracking") {
      setBudgetType(budgetTypeSetting);
    }

    const currencySetting = settingsCollection.state.get("display_currency")?.value;
    if (
      displaySave().state === "idle" &&
      (currencySetting === "USD" || currencySetting === "IDR")
    ) {
      setCurrency(currencySetting);
    }

    const privacySetting = settingsCollection.state.get("privacy_mode")?.value;
    if (privacySetting === "true" || privacySetting === "false") {
      // privacy signal reacts to settings collection directly
    }

    const df = settingsCollection.state.get("date_format")?.value;
    if (df === "us" || df === "eu" || df === "iso") {
      setDateFormat(df);
    }

    const hc = settingsCollection.state.get("hide_closed_accounts")?.value;
    if (hc === "true") setHideClosed(true);
    else setHideClosed(false);

    const fdw = settingsCollection.state.get("first_day_of_week")?.value;
    if (fdw === "sunday" || fdw === "monday") setFirstDayOfWeek(fdw);

    const nf = settingsCollection.state.get("number_format")?.value;
    if (displaySave().state === "idle")
      setNumberFormat(nf === "comma-dot" || nf === "dot-comma" || nf === "space-dot" ? nf : "auto");
  }

  async function loadPageData() {
    setError(null);
    try {
      loadSettingsStore();
      await loadRates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }

  async function loadRates() {
    const data = await api.rates();
    setExchangeRate(data.usdToIdr ?? 16000);
  }

  function handleRateUpdate() {
    dispatch("update_exchange_rate", { usdToIdr: Math.round(exchangeRate()) });
  }

  function updateBudgetType(value: BudgetType) {
    setBudgetType(value);
    dispatch("update_setting", { key: "budget_type", value });
    setSetting("budget_type", value);
  }

  function updateCurrency(value: Currency) {
    setCurrency(value);
    void saveDisplaySetting({ key: "display_currency", value });
  }

  function updateDateFormat(value: DateFormat) {
    setDateFormat(value);
    dispatch("update_setting", { key: "date_format", value });
    setSetting("date_format", value);
  }

  function togglePrivacy() {
    const next = String(!privacy().enabled);
    dispatch("update_setting", { key: "privacy_mode", value: next });
    setSetting("privacy_mode", next);
  }

  function toggleHideClosed() {
    const next = !hideClosed();
    setHideClosed(next);
    dispatch("update_setting", { key: "hide_closed_accounts", value: String(next) });
    setSetting("hide_closed_accounts", String(next));
  }

  function updateFirstDayOfWeek(value: "sunday" | "monday") {
    setFirstDayOfWeek(value);
    dispatch("update_setting", { key: "first_day_of_week", value });
    setSetting("first_day_of_week", value);
  }

  function updateNumberFormat(value: NumberFormatPreference) {
    setNumberFormat(value);
    void saveDisplaySetting({ key: "number_format", value });
  }

  function handleExport() {
    window.location.href = "/api/export/csv";
  }

  return (
    <div class="page">
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">Configure your budget preferences</p>

      <PageState
        loading={loading()}
        error={error()}
        onRetry={loadPageData}
        loadingMessage="Loading..."
      >
        {/* Privacy Mode */}
        <div class="settings-section">
          <h2>Privacy Mode</h2>
          <p class="settings-description">
            Blur all monetary amounts to keep them hidden from onlookers.
          </p>
          <div class="privacy-toggle">
            <input
              type="checkbox"
              id="privacy-toggle"
              checked={privacy().enabled}
              onChange={togglePrivacy}
            />
            <label for="privacy-toggle">
              {privacy().enabled ? "Amounts are hidden" : "Amounts are visible"}
            </label>
          </div>
        </div>

        {/* Exchange Rate */}
        <div class="settings-section">
          <h2>Exchange Rate</h2>
          <p class="settings-description">
            1 USD to IDR conversion rate for dual-currency display.
          </p>
          <div class="inline-form">
            <input
              type="number"
              value={exchangeRate()}
              onInput={(e) => setExchangeRate(parseInt(e.currentTarget.value) || 0)}
              min="1"
              style="max-width:200px"
            />
            <button class="btn btn-primary btn-sm" onClick={handleRateUpdate}>
              Update
            </button>
          </div>
        </div>

        {/* Budget Type */}
        <div class="settings-section">
          <h2>Budget Type</h2>
          <p class="settings-description">
            Envelope: assign available money to categories. Tracking: set spending targets.
          </p>
          <div class="settings-options">
            <button
              class="btn"
              classList={{
                "btn-primary": budgetType() === "envelope",
                "btn-secondary": budgetType() !== "envelope",
              }}
              onClick={() => updateBudgetType("envelope")}
            >
              Envelope Budget
            </button>
            <button
              class="btn"
              classList={{
                "btn-primary": budgetType() === "tracking",
                "btn-secondary": budgetType() !== "tracking",
              }}
              onClick={() => updateBudgetType("tracking")}
            >
              Tracking Budget
            </button>
          </div>
        </div>

        {/* Display Currency */}
        <div class="settings-section">
          <h2>
            <label for="money-currency">Currency</label>
          </h2>
          <select
            id="money-currency"
            disabled={displaySave().state === "saving"}
            value={currency()}
            onChange={(e) =>
              updateCurrency(Schema.decodeUnknownSync(CurrencySchema)(e.currentTarget.value))
            }
            style="max-width:200px"
          >
            <option value="USD">US dollar ($)</option>
            <option value="IDR">Indonesian rupiah (Rp)</option>
          </select>
        </div>

        <Show when={displaySave().state === "failed"}>
          <div class="inline-save-error" role="alert">
            <span>
              {(() => {
                const save = displaySave();
                return save.state === "failed" ? save.message : "";
              })()}
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => {
                const save = displaySave();
                if (save.state === "failed")
                  void saveDisplaySetting({ key: save.key, value: save.value });
              }}
            >
              Retry
            </button>
          </div>
        </Show>
        {/* Date Format */}
        <div class="settings-section">
          <h2>Date Format</h2>
          <p class="settings-description">Choose how dates are displayed throughout the app.</p>
          <select
            value={dateFormat()}
            onChange={(e) =>
              updateDateFormat(Schema.decodeUnknownSync(DateFormatSchema)(e.currentTarget.value))
            }
            style="max-width:200px"
          >
            <option value="iso">ISO (2026-05-13)</option>
            <option value="us">US (05/13/2026)</option>
            <option value="eu">EU (13/05/2026)</option>
          </select>
        </div>

        {/* First Day of Week */}
        <div class="settings-section">
          <h2>First Day of Week</h2>
          <p class="settings-description">Set which day the calendar week starts on.</p>
          <select
            value={firstDayOfWeek()}
            onChange={(e) =>
              updateFirstDayOfWeek(Schema.decodeUnknownSync(FirstDaySchema)(e.currentTarget.value))
            }
            style="max-width:200px"
          >
            <option value="sunday">Sunday</option>
            <option value="monday">Monday</option>
          </select>
        </div>

        {/* Number Format */}
        <div class="settings-section">
          <h2>
            <label for="money-number-format">Number Format</label>
          </h2>
          <p class="settings-description">
            Choose how numbers are formatted (thousands/decimal separators).
          </p>
          <select
            id="money-number-format"
            disabled={displaySave().state === "saving"}
            value={numberFormat()}
            onChange={(e) =>
              updateNumberFormat(
                Schema.decodeUnknownSync(NumberFormatSchema)(e.currentTarget.value),
              )
            }
            style="max-width:200px"
          >
            <option value="auto">Automatic (currency)</option>
            <option value="comma-dot">1,234.56</option>
            <option value="dot-comma">1.234,56 (Indonesia)</option>
            <option value="space-dot">1 234.56</option>
          </select>
        </div>

        {/* Account Display */}
        <div class="settings-section">
          <h2>Account Display</h2>
          <p class="settings-description">Control which accounts appear in the account list.</p>
          <div class="form-check">
            <input
              type="checkbox"
              id="hide-closed"
              checked={hideClosed()}
              onChange={toggleHideClosed}
            />
            <label for="hide-closed">Hide closed accounts</label>
          </div>
        </div>

        {/* Export */}
        <div class="settings-section">
          <h2>Export Data</h2>
          <p class="settings-description">Download your transactions as a CSV file.</p>
          <button class="btn btn-secondary" onClick={handleExport}>
            Export CSV
          </button>
        </div>
      </PageState>
    </div>
  );
}
