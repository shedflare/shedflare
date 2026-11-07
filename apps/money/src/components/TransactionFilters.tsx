import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { dispatch } from "../lib/pending-ops";
import { api } from "../lib/api";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { formatCalendarDate } from "../domain/types";
import { listenForMoneyDataChanged } from "../lib/data-events";
import MoneyIcon from "./MoneyIcon";
import {
  amountPresets,
  type Condition,
  type CondOp,
  conditionParts,
  FIELD_LABELS,
  FIELD_NAMES,
  type FieldName,
  flipCondition,
  isListField,
  type ListField,
  listConditionIndex,
  parseSavedConditions,
  putCondition,
  selectedIds,
  toggleListValue,
} from "../lib/filter-conditions";
import type { FiltersResponse } from "../domain/schemas-client";

export type { Condition, CondOp };

type SavedFilter = Pick<FiltersResponse["filters"][number], "id" | "name" | "conditions"> & {
  conditionsOp: "and" | "or";
};

/** One row of the picker menu. `keepOpen` rows toggle list values in place. */
type MenuOption = {
  key: string;
  label: string;
  hint?: string;
  selected?: boolean;
  submenu?: boolean;
  keepOpen?: boolean;
  run: () => void;
};

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return formatCalendarDate(date);
}

/**
 * Linear-style filters: one button opens a searchable field menu, picking a value applies it at
 * once, and each chip's operator and value can be changed in place.
 */
export default function TransactionFilters(props: {
  accountId?: string;
  activeConditions: Condition[];
  activeConditionsOp?: "and" | "or";
  onConditionsChange: (
    conditions: Condition[],
    conditionsOp: "and" | "or",
    filterId: string | null,
  ) => void;
}) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const conditionsOp = () => props.activeConditionsOp ?? "and";
  const [lists, { refetch }] = createResource(async () => {
    const [accounts, categories, filters] = await Promise.all([
      api.accounts(),
      api.categories(),
      api.filters(),
    ]);
    return {
      accounts: accounts.accounts.map(({ id, name }) => ({ id, name, group: null })),
      categories: categories.categories.map((row) => ({
        id: row.id,
        name: row.name,
        group: row.group_name ?? null,
      })),
      filters: filters.filters.map(
        (filter): SavedFilter => ({
          id: filter.id,
          name: filter.name,
          conditions: filter.conditions,
          conditionsOp: filter.conditionsOp === "or" ? "or" : "and",
        }),
      ),
    };
  });
  onCleanup(listenForMoneyDataChanged(() => void refetch()));
  const listRows = (field: ListField) =>
    (field === "category" ? lists()?.categories : lists()?.accounts) ?? [];
  const nameOf = (field: ListField, id: string) =>
    listRows(field).find((row) => row.id === id)?.name;

  const [open, setOpen] = createSignal(false);
  const [step, setStep] = createSignal<FieldName | null>(null);
  /** The chip being edited from its value segment; null adds a new condition. */
  const [editing, setEditing] = createSignal<number | null>(null);
  const [query, setQuery] = createSignal("");
  const [dateValue, setDateValue] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [savedOpen, setSavedOpen] = createSignal(false);
  const [saveName, setSaveName] = createSignal("");
  let root: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;

  const outside = (event: PointerEvent) => {
    if (root && event.target instanceof Node && !root.contains(event.target)) close();
  };
  document.addEventListener("pointerdown", outside);
  onCleanup(() => document.removeEventListener("pointerdown", outside));

  function change(conditions: Condition[], op: "and" | "or" = conditionsOp()) {
    props.onConditionsChange(conditions, op, null);
  }

  function openMenu(field: FieldName | null = null, index: number | null = null) {
    setSavedOpen(false);
    setStep(field);
    setEditing(index);
    setQuery("");
    setDateValue("");
    setActive(0);
    setOpen(true);
    queueMicrotask(() => search?.focus());
  }

  function close() {
    setOpen(false);
    setSavedOpen(false);
    setStep(null);
    setEditing(null);
  }

  function apply(condition: Condition) {
    change(putCondition(props.activeConditions, condition, editing()));
    close();
  }

  function pickField(field: FieldName) {
    setStep(field);
    setQuery("");
    setActive(0);
    search?.focus();
  }

  function listOptions(field: ListField, text: string, prefix = ""): MenuOption[] {
    const chosen = selectedIds(
      props.activeConditions[listConditionIndex(props.activeConditions, field)],
    );
    return listRows(field)
      .filter((row) => !text || `${row.group ?? ""} ${row.name}`.toLowerCase().includes(text))
      .map((row) => ({
        key: `${field}:${row.id}`,
        label: `${prefix}${row.name}`,
        hint: row.group ?? undefined,
        selected: chosen.includes(row.id),
        keepOpen: true,
        run: () => change(toggleListValue(props.activeConditions, field, row.id)),
      }));
  }

  const options = createMemo((): MenuOption[] => {
    const text = query().trim().toLowerCase();
    const raw = query().trim();
    const field = step();
    if (field === null) {
      const fields = FIELD_NAMES.filter(
        (name) =>
          !(name === "account" && props.accountId) &&
          (!text || FIELD_LABELS[name].toLowerCase().includes(text)),
      ).map((name) => ({
        key: name,
        label: FIELD_LABELS[name],
        submenu: true,
        run: () => pickField(name),
      }));
      if (!text) return fields;
      // Typing at the top level also reaches values directly, like Linear.
      return [
        ...fields,
        ...listOptions("category", text, "Category › ").slice(0, 6),
        ...(props.accountId ? [] : listOptions("account", text, "Account › ").slice(0, 4)),
        {
          key: "payee-contains",
          label: `Payee contains “${raw}”`,
          run: () => apply({ field: "payee", op: "contains", value: raw }),
        },
        {
          key: "notes-contains",
          label: `Notes contain “${raw}”`,
          run: () => apply({ field: "notes", op: "contains", value: raw }),
        },
      ];
    }
    if (isListField(field)) return listOptions(field, text);
    if (field === "payee" || field === "notes") {
      if (!raw) return [];
      return [
        {
          key: "contains",
          label: `Contains “${raw}”`,
          run: () => apply({ field, op: "contains", value: raw }),
        },
        { key: "is", label: `Is “${raw}”`, run: () => apply({ field, op: "is", value: raw }) },
        {
          key: "not",
          label: `Does not contain “${raw}”`,
          run: () => apply({ field, op: "doesNotContain", value: raw }),
        },
      ];
    }
    if (field === "amount") {
      const cents = fmt().parseInput(raw);
      if (!raw || !Number.isFinite(cents) || cents === 0) return [];
      return amountPresets(cents).map((preset) => ({
        key: preset.label,
        label: `${preset.label} ${fmt().formatCents(Math.abs(cents))}`,
        run: () => apply(preset.condition),
      }));
    }
    if (field === "date") {
      const date = dateValue();
      if (date) {
        return [
          { key: "gte", label: `On or after ${df().formatDate(date)}`, op: "gte" as const },
          { key: "lte", label: `On or before ${df().formatDate(date)}`, op: "lte" as const },
          { key: "is", label: `On ${df().formatDate(date)}`, op: "is" as const },
        ].map(({ op, ...option }) => ({
          ...option,
          run: () => apply({ field, op, value: date }),
        }));
      }
      return [
        { key: "7", label: "Last 7 days", days: 6 },
        { key: "30", label: "Last 30 days", days: 29 },
      ].map(({ days, ...option }) => ({
        ...option,
        run: () => apply({ field, op: "gte", value: daysAgo(days) }),
      }));
    }
    return [
      { key: "yes", label: "Yes", run: () => apply({ field, op: "is", value: true }) },
      { key: "no", label: "No", run: () => apply({ field, op: "is", value: false }) },
    ];
  });

  function choose(option: MenuOption | undefined) {
    if (!option) return;
    option.run();
    if (option.keepOpen) search?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    const count = options().length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (count ? (index + 1) % count : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (count ? (index - 1 + count) % count : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(options()[Math.min(active(), count - 1)]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (step() !== null && editing() === null) setStep(null);
      else close();
    } else if (event.key === "Backspace" && !query() && step() !== null && editing() === null) {
      event.preventDefault();
      setStep(null);
      setActive(0);
    }
  }

  const placeholder = () => {
    const field = step();
    if (field === null) return "Add filter…";
    if (field === "amount") return "Type an amount";
    if (field === "payee" || field === "notes") return `${FIELD_LABELS[field]} text…`;
    if (field === "date" || field === "cleared" || field === "reconciled")
      return FIELD_LABELS[field];
    return `Find ${FIELD_LABELS[field].toLowerCase()}…`;
  };

  const parts = (condition: Condition) =>
    conditionParts(condition, {
      name: nameOf,
      cents: (cents) => fmt().formatCents(cents),
      date: (date) => df().formatDate(date),
    });

  const matchedFilter = () =>
    lists()?.filters.find((f) => JSON.stringify(props.activeConditions) === f.conditions) ?? null;

  function saveAsNew() {
    const name = saveName().trim();
    if (!name) return;
    dispatch("create_filter", {
      filter: {
        name,
        conditions: JSON.stringify(props.activeConditions),
        conditionsOp: conditionsOp(),
      },
    });
    setSaveName("");
    setSavedOpen(false);
  }

  return (
    <div class="filter-bar" ref={(element) => (root = element)}>
      <Show when={props.activeConditions.length > 1}>
        <button
          type="button"
          class="filter-match"
          title="Switch between matching all or any filter"
          onClick={() => change(props.activeConditions, conditionsOp() === "and" ? "or" : "and")}
        >
          Match {conditionsOp() === "and" ? "all" : "any"}
        </button>
      </Show>
      <For each={props.activeConditions}>
        {(condition, index) => {
          const label = () => parts(condition);
          const flipped = () => flipCondition(condition);
          return (
            <span class="filter-chip">
              <button
                type="button"
                class="filter-chip-field"
                onClick={() => openMenu(condition.field, index())}
              >
                {label().field}
              </button>
              <button
                type="button"
                class="filter-chip-op"
                disabled={!flipped()}
                title={flipped() ? "Switch operator" : undefined}
                onClick={() => {
                  const next = flipped();
                  if (next) change(putCondition(props.activeConditions, next, index()));
                }}
              >
                {label().op}
              </button>
              <button
                type="button"
                class="filter-chip-value"
                title="Change value"
                onClick={() => openMenu(condition.field, index())}
              >
                {label().value}
              </button>
              <button
                type="button"
                class="filter-chip-remove"
                aria-label={`Remove ${label().field} filter`}
                onClick={() => change(props.activeConditions.filter((_, at) => at !== index()))}
              >
                <MoneyIcon name="close" size={12} />
              </button>
            </span>
          );
        }}
      </For>
      <div class="filter-anchor">
        <button
          type="button"
          class="filter-add"
          classList={{ "is-empty": props.activeConditions.length === 0 }}
          aria-expanded={open()}
          onClick={() => (open() ? close() : openMenu())}
        >
          <MoneyIcon name={props.activeConditions.length ? "plus" : "filter"} size={14} />
          <Show when={props.activeConditions.length === 0}>Filter</Show>
        </button>
        <Show when={open()}>
          <div class="filter-menu" role="dialog" aria-label="Add filter">
            <div class="filter-menu-search">
              <Show when={step()}>
                {(field) => (
                  <button
                    type="button"
                    class="filter-menu-back"
                    aria-label="Back to fields"
                    onClick={() => (editing() === null ? setStep(null) : close())}
                  >
                    {FIELD_LABELS[field()]}
                  </button>
                )}
              </Show>
              <input
                ref={(element) => (search = element)}
                value={query()}
                placeholder={placeholder()}
                aria-label={placeholder()}
                inputMode={step() === "amount" ? fmt().inputMode : undefined}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            <Show when={step() === "date"}>
              <div class="filter-menu-date">
                <input
                  type="date"
                  aria-label="Date"
                  value={dateValue()}
                  onInput={(event) => {
                    setDateValue(event.currentTarget.value);
                    setActive(0);
                  }}
                />
              </div>
            </Show>
            <div class="filter-menu-list" role="listbox">
              <For
                each={options()}
                fallback={
                  <p class="filter-menu-empty">
                    {step() === "amount"
                      ? "Type an amount to compare"
                      : step() === "payee" || step() === "notes"
                        ? "Type the text to match"
                        : lists.loading
                          ? "Loading…"
                          : "No matches"}
                  </p>
                }
              >
                {(option, index) => (
                  <button
                    type="button"
                    role="option"
                    class="filter-menu-item"
                    classList={{ "is-active": index() === active() }}
                    aria-selected={option.selected ?? index() === active()}
                    onPointerMove={() => setActive(index())}
                    onClick={() => choose(option)}
                  >
                    <Show when={option.selected !== undefined}>
                      <span class="filter-menu-check" classList={{ "is-on": option.selected }}>
                        <Show when={option.selected}>
                          <MoneyIcon name="check" size={11} />
                        </Show>
                      </span>
                    </Show>
                    <span class="filter-menu-label">{option.label}</span>
                    <Show when={option.hint}>
                      <small>{option.hint}</small>
                    </Show>
                    <Show when={option.submenu}>
                      <MoneyIcon name="chevron" size={13} />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
      <Show when={props.activeConditions.length > 0}>
        <button type="button" class="filter-clear" onClick={() => change([], "and")}>
          Clear
        </button>
      </Show>
      <Show when={props.activeConditions.length > 0 || lists()?.filters.length}>
        <div class="filter-anchor filter-saved">
          <button
            type="button"
            class="filter-clear"
            aria-expanded={savedOpen()}
            onClick={() => {
              setOpen(false);
              setSavedOpen(!savedOpen());
            }}
          >
            {props.activeConditions.length ? (matchedFilter()?.name ?? "Save view") : "Saved views"}{" "}
            ▾
          </button>
          <Show when={savedOpen()}>
            <div class="filter-menu filter-menu-right" role="dialog" aria-label="Saved views">
              <Show when={lists()?.filters.length}>
                <div class="filter-menu-list">
                  <For each={lists()?.filters}>
                    {(saved) => (
                      <div class="filter-menu-row">
                        <button
                          type="button"
                          class="filter-menu-item"
                          onClick={() => {
                            props.onConditionsChange(
                              parseSavedConditions(saved.conditions),
                              saved.conditionsOp,
                              saved.id,
                            );
                            close();
                          }}
                        >
                          <span class="filter-menu-label">{saved.name}</span>
                        </button>
                        <button
                          type="button"
                          class="filter-menu-delete"
                          aria-label={`Delete “${saved.name}”`}
                          onClick={() => {
                            dispatch("delete_filter", { id: saved.id });
                            change([], "and");
                          }}
                        >
                          <MoneyIcon name="close" size={12} />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={props.activeConditions.length > 0 && !matchedFilter()}>
                <form
                  class="filter-menu-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveAsNew();
                  }}
                >
                  <input
                    value={saveName()}
                    placeholder="Name this view…"
                    aria-label="View name"
                    onInput={(event) => setSaveName(event.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    class="btn btn-primary btn-xs"
                    disabled={!saveName().trim()}
                  >
                    Save
                  </button>
                </form>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export type { SavedFilter };
