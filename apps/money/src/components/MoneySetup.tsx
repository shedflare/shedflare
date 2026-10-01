import { createSignal, For, Index, Show } from "solid-js";
import MoneyDialog from "./MoneyDialog";
import MoneyIcon from "./MoneyIcon";
import CategoryIconPicker from "./CategoryIconPicker";
import { dispatch } from "../lib/pending-ops";
import { emitMoneyDataChanged } from "../lib/data-events";
import { applySettings } from "../lib/settings-store";
import { api } from "../lib/api";
import { formatCentsValue } from "../lib/currency";
import { parseAmountInput, type CurrencyCode } from "../domain/money-amount";
import { STARTER_CATEGORIES, type SetupCategory } from "../domain/setup";

type CategoryDraft = { key: number; selected: boolean; category: SetupCategory };
export default function MoneySetup(props: { initialCurrency: CurrencyCode; onClose: () => void }) {
  const requestId = crypto.randomUUID();
  const [step, setStep] = createSignal<"currency" | "account" | "categories">("currency");
  const [currency, setCurrency] = createSignal<CurrencyCode>(props.initialCurrency);
  const [name, setName] = createSignal("Everyday");
  const [balance, setBalance] = createSignal("");
  const [categories, setCategories] = createSignal<CategoryDraft[]>(
    STARTER_CATEGORIES.map((category, key) => ({ key, selected: true, category: { ...category } })),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const title = () =>
    step() === "currency"
      ? "Your currency"
      : step() === "account"
        ? "Your first account"
        : "Your categories";
  function accountBalance() {
    return balance().trim() ? parseAmountInput(balance(), currency()) : 0;
  }
  function next(event: SubmitEvent) {
    event.preventDefault();
    setError(null);
    if (step() === "currency") setStep("account");
    else if (step() === "account") {
      if (!name().trim() || !Number.isSafeInteger(accountBalance())) {
        setError("Enter an account name and valid balance.");
        return;
      }
      setStep("categories");
    } else void save(false);
  }
  function editCategory(key: number, change: Partial<SetupCategory>) {
    setCategories((rows) =>
      rows.map((row) =>
        row.key === key ? { ...row, category: { ...row.category, ...change } } : row,
      ),
    );
  }
  async function save(skip: boolean, skipCategories = false) {
    if (busy()) return;
    const chosen = skipCategories
      ? []
      : categories()
          .filter((row) => row.selected)
          .map((row) => row.category);
    if (
      !skip &&
      (!Number.isSafeInteger(accountBalance()) ||
        !name().trim() ||
        chosen.some((row) => !row.name.trim()))
    ) {
      setError("Check the account and category names.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dispatch(
        "setup_money",
        skip
          ? { mode: "skip", requestId, currency: currency() }
          : {
              mode: "complete",
              requestId,
              currency: currency(),
              account: { name: name().trim(), balance: accountBalance() },
              categories: chosen,
            },
      ).promise;
      applySettings(await api.settings());
      emitMoneyDataChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not set up your money");
      emitMoneyDataChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <MoneyDialog title={title()} drawer busy={busy()} onClose={props.onClose}>
      <form class="money-form money-setup" onSubmit={next}>
        <div
          class="setup-progress"
          aria-label={`Step ${step() === "currency" ? 1 : step() === "account" ? 2 : 3} of 3`}
        >
          <span classList={{ active: step() === "currency" }} />
          <span classList={{ active: step() === "account" }} />
          <span classList={{ active: step() === "categories" }} />
        </div>
        <Show when={step() === "currency"}>
          <div class="setup-currencies" role="group" aria-label="Currency">
            <For
              each={[
                { code: "USD" as const, name: "US dollar", symbol: "$" },
                { code: "IDR" as const, name: "Indonesian rupiah", symbol: "Rp" },
              ]}
            >
              {(option) => (
                <button
                  type="button"
                  class="setup-currency"
                  classList={{ selected: currency() === option.code }}
                  aria-pressed={currency() === option.code}
                  disabled={busy()}
                  onClick={() => setCurrency(option.code)}
                >
                  <strong>{option.symbol}</strong>
                  <span>
                    {option.name}
                    <small>{option.code}</small>
                  </span>
                  <Show when={currency() === option.code}>
                    <MoneyIcon name="check" size={18} />
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div class="setup-currency-preview">{formatCentsValue(125000000, currency())}</div>
        </Show>
        <Show when={step() === "account"}>
          <div class="form-group">
            <label for="setup-account-name">Name</label>
            <input
              id="setup-account-name"
              value={name()}
              required
              disabled={busy()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <div class="form-group">
            <label for="setup-opening">Opening balance</label>
            <div class="setup-balance">
              <span>{currency() === "IDR" ? "Rp" : "$"}</span>
              <input
                id="setup-opening"
                type="text"
                inputmode={currency() === "IDR" ? "numeric" : "decimal"}
                value={balance()}
                placeholder={currency() === "IDR" ? "0" : "0.00"}
                disabled={busy()}
                onInput={(event) => setBalance(event.currentTarget.value)}
              />
            </div>
          </div>
        </Show>
        <Show when={step() === "categories"}>
          <div class="setup-category-list">
            <Index each={categories()}>
              {(row) => (
                <div class="setup-category-row" classList={{ excluded: !row().selected }}>
                  <input
                    type="checkbox"
                    aria-label={`Include ${row().category.name}`}
                    checked={row().selected}
                    disabled={busy()}
                    onChange={(event) =>
                      setCategories((rows) =>
                        rows.map((item) =>
                          item.key === row().key
                            ? { ...item, selected: event.currentTarget.checked }
                            : item,
                        ),
                      )
                    }
                  />
                  <CategoryIconPicker
                    name={row().category.name}
                    value={row().category.icon}
                    onChange={(icon) => editCategory(row().key, { icon })}
                    disabled={busy() || !row().selected}
                  />
                  <input
                    class="setup-category-name"
                    aria-label={`Category name ${row().key + 1}`}
                    value={row().category.name}
                    disabled={busy() || !row().selected}
                    onInput={(event) =>
                      editCategory(row().key, { name: event.currentTarget.value })
                    }
                  />
                </div>
              )}
            </Index>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="setup-footer">
          <Show when={step() !== "currency"}>
            <button
              type="button"
              class="btn btn-secondary"
              disabled={busy()}
              onClick={() => {
                setError(null);
                setStep(step() === "categories" ? "account" : "currency");
              }}
            >
              Back
            </button>
          </Show>
          <button type="submit" class="btn btn-primary" disabled={busy()}>
            {busy() ? "Saving…" : step() === "categories" ? "Start using Money" : "Continue"}
          </button>
        </div>
        <button
          type="button"
          class="setup-skip text-button"
          disabled={busy()}
          onClick={() => void save(step() !== "categories", step() === "categories")}
        >
          {step() === "categories" ? "Skip categories" : "Skip setup"}
        </button>
      </form>
    </MoneyDialog>
  );
}
