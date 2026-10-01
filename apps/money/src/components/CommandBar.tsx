import { createEffect, createMemo, createSignal, For, Index, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "../lib/api";
import { useMoneyShell } from "./MoneyShellContext";
import type {
  AccountsResponse,
  CategoriesResponse,
  PayeesResponse,
  SchedulesResponse,
} from "../domain/schemas-client";

type AccountRow = AccountsResponse["accounts"][number];
type PayeeRow = PayeesResponse["payees"][number];
type CategoryRow = CategoriesResponse["categories"][number];
type ScheduleRow = SchedulesResponse["schedules"][number];

interface CmdResult {
  id: string;
  label: string;
  description?: string;
  icon: string;
  action: () => void;
}

interface CmdSection {
  title: string;
  results: CmdResult[];
}

function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 50;
  return 0;
}

function fuzzyFilter(query: string, items: CmdResult[]): CmdResult[] {
  if (!query) return items;
  return items
    .map((item) => ({
      item,
      score: score(query, item.label) + score(query, item.description ?? ""),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

export default function CommandBar(props: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const shell = useMoneyShell();
  const [inputEl, setInputEl] = createSignal<HTMLInputElement>();
  const [query, setQuery] = createSignal("");
  const [accounts, setAccounts] = createSignal<AccountRow[]>([]);
  const [payees, setPayees] = createSignal<PayeeRow[]>([]);
  const [categories, setCategories] = createSignal<CategoryRow[]>([]);
  const [schedules, setSchedules] = createSignal<ScheduleRow[]>([]);

  const pages: CmdResult[] = [
    { id: "/", label: "Home", icon: "⌂", action: () => navigate("/") },
    { id: "/budget", label: "Budget", icon: "💰", action: () => navigate("/budget") },
    { id: "/accounts", label: "Accounts", icon: "🏦", action: () => navigate("/accounts") },
    {
      id: "/transactions",
      label: "Activity",
      icon: "💳",
      action: () => navigate("/transactions"),
    },
    { id: "/reports", label: "Reports", icon: "📈", action: () => navigate("/reports") },
    { id: "/schedules", label: "Schedules", icon: "🔄", action: () => navigate("/schedules") },
    { id: "/payees", label: "Payees", icon: "👤", action: () => navigate("/payees") },
    { id: "/rules", label: "Rules", icon: "⚙️", action: () => navigate("/rules") },
    { id: "/tags", label: "Tags", icon: "🏷️", action: () => navigate("/tags") },
    { id: "/settings", label: "Settings", icon: "🔧", action: () => navigate("/settings") },
  ];

  createEffect(() => {
    if (props.open) {
      setQuery("");
      void api.accounts().then((d) => setAccounts([...d.accounts]));
      void api.payees().then((d) => setPayees([...d.payees]));
      void api.categories().then((d) => setCategories([...d.categories]));
      void api.schedules().then((d) => setSchedules([...d.schedules]));
    }
  });

  function readAccounts(): CmdResult[] {
    return accounts().map(
      (a): CmdResult => ({
        id: a.id,
        label: a.name,
        description: "Account",
        icon: "🏦",
        action: () => navigate(`/accounts/${a.id}`),
      }),
    );
  }

  function readPayees(): CmdResult[] {
    return payees().map(
      (p): CmdResult => ({
        id: p.id,
        label: p.name,
        description: "Payee",
        icon: "👤",
        action: () => navigate(`/transactions?q=${encodeURIComponent(p.name)}`),
      }),
    );
  }

  function readCategories(): CmdResult[] {
    return categories().map(
      (c): CmdResult => ({
        id: c.id,
        label: c.name,
        description: "Category",
        icon: "📁",
        action: () => navigate(`/budget?category=${encodeURIComponent(c.id)}`),
      }),
    );
  }

  function readSchedules(): CmdResult[] {
    return schedules().map(
      (s): CmdResult => ({
        id: s.id,
        label: s.name ?? "Untitled Schedule",
        description: "Schedule",
        icon: "🔄",
        action: () => navigate(`/schedules?focus=${encodeURIComponent(s.id)}`),
      }),
    );
  }

  const sections = createMemo(() => {
    const q = query();
    const result: CmdSection[] = [];

    const addTransaction: CmdResult = {
      id: "add-transaction",
      label: "Add transaction",
      description: "Open the transaction composer",
      icon: "+",
      action: () => shell.openTransaction(),
    };
    const trimmedQuery = q.trim();
    const actions: CmdResult[] = trimmedQuery
      ? [
          {
            id: "search-transactions",
            label: `Search transactions for “${trimmedQuery}”`,
            description: "Search payees, notes, categories, and accounts",
            icon: "⌕",
            action: () => navigate(`/transactions?q=${encodeURIComponent(trimmedQuery)}`),
          },
          ...fuzzyFilter(q, [addTransaction]),
        ]
      : [addTransaction];
    result.push({ title: "Actions", results: actions });

    const filteredPages = fuzzyFilter(q, pages);
    if (filteredPages.length > 0) {
      result.push({ title: "Pages", results: filteredPages });
    }

    const filteredAccounts = fuzzyFilter(q, readAccounts());
    if (filteredAccounts.length > 0) {
      result.push({ title: "Accounts", results: filteredAccounts });
    }

    const filteredPayees = fuzzyFilter(q, readPayees());
    if (filteredPayees.length > 0) {
      result.push({ title: "Payees", results: filteredPayees });
    }

    const filteredCategories = fuzzyFilter(q, readCategories());
    if (filteredCategories.length > 0) {
      result.push({ title: "Categories", results: filteredCategories });
    }

    const filteredSchedules = fuzzyFilter(q, readSchedules());
    if (filteredSchedules.length > 0) {
      result.push({ title: "Schedules", results: filteredSchedules });
    }

    return result;
  });

  const flatResults = createMemo(() =>
    sections().flatMap((s) => s.results.map((r) => ({ section: s.title, result: r }))),
  );

  const [selectedIndex, setSelectedIndex] = createSignal(0);

  createEffect(() => {
    query();
    if (props.open) setSelectedIndex(0);
  });

  const executeSelected = () => {
    const flat = flatResults();
    if (flat.length === 0) return;
    const idx = Math.min(selectedIndex(), flat.length - 1);
    props.onClose();
    flat[idx].result.action();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const flat = flatResults();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    inputEl()?.focus();
  });

  return (
    <div class="cmd-overlay" onClick={props.onClose}>
      <div
        class="cmd-modal"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div class="cmd-input-wrap">
          <span class="cmd-input-icon">⌘</span>
          <input
            ref={setInputEl}
            type="text"
            class="cmd-input"
            placeholder="Search transactions, accounts, payees..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <kbd class="cmd-hint">ESC</kbd>
        </div>
        <div class="cmd-results">
          <Show
            when={sections().length > 0}
            fallback={
              <div class="cmd-empty">
                <Show when={query()}>No results found</Show>
              </div>
            }
          >
            <For each={sections()}>
              {(section) => (
                <div class="cmd-section">
                  <div class="cmd-section-title">{section.title}</div>
                  <Index each={section.results}>
                    {(item) => {
                      const globalIdx = createMemo(() => {
                        let count = 0;
                        for (const s of sections()) {
                          for (const r of s.results) {
                            if (r === item()) return count;
                            count++;
                          }
                        }
                        return 0;
                      });
                      return (
                        <button
                          class="cmd-item"
                          classList={{ "cmd-item-selected": selectedIndex() === globalIdx() }}
                          onMouseEnter={() => setSelectedIndex(globalIdx())}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            props.onClose();
                            item().action();
                          }}
                        >
                          <span class="cmd-item-icon">{item().icon}</span>
                          <div class="cmd-item-body">
                            <span class="cmd-item-label">{item().label}</span>
                            <Show when={item().description}>
                              <span class="cmd-item-desc">{item().description}</span>
                            </Show>
                          </div>
                        </button>
                      );
                    }}
                  </Index>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
