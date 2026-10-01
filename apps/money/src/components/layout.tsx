import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { A, useLocation, useNavigate, type RouteSectionProps } from "@solidjs/router";
import { createHotkey } from "@tanstack/solid-hotkeys";
import CommandBar from "./CommandBar";
import AddTransactionModal from "./AddTransactionModal";
import ToastCenter from "./ToastCenter";
import MoneyIcon, { type MoneyIconName } from "./MoneyIcon";
import MoneyDialog from "./MoneyDialog";
import { MoneyShellProvider, type OpenTransactionOptions } from "./MoneyShellContext";
import { undo, redo, undoStack, redoStack, historyBusy } from "../lib/undo-stack";
import { BUILD_INFO } from "../lib/build-info";
import { loadSettings } from "../lib/settings-store";
import { useCurrency } from "../lib/currency";
import { api } from "../lib/api";
import type { AccountsResponse, CategoriesResponse } from "../domain/schemas-client";

interface NavItem {
  path: string;
  label: string;
  icon: MoneyIconName;
  activePaths?: string[];
}

type AccountRow = Pick<AccountsResponse["accounts"][number], "id" | "name" | "closed">;
type CategoryRow = Pick<CategoriesResponse["categories"][number], "id" | "name"> & {
  groupName: string | null;
  isIncome: boolean;
};

const PRIMARY_NAV: NavItem[] = [
  { path: "/", label: "Home", icon: "home" },
  { path: "/budget", label: "Budget", icon: "budget" },
  { path: "/transactions", label: "Activity", icon: "activity" },
  { path: "/accounts", label: "Accounts", icon: "accounts" },
  {
    path: "/schedules",
    label: "Recurring",
    icon: "calendar",
    activePaths: ["/schedules"],
  },
];

const SECONDARY_NAV: NavItem[] = [
  { path: "/reports", label: "Reports", icon: "chart" },
  { path: "/categories", label: "Categories", icon: "budget" },
  { path: "/payees", label: "Payees", icon: "activity" },
  { path: "/rules", label: "Rules", icon: "settings" },
  { path: "/tags", label: "Tags", icon: "more" },
  { path: "/settings", label: "Settings", icon: "settings" },
];

type MobileNavItem =
  | { kind: "route"; path: string; label: string; icon: MoneyIconName }
  | { kind: "add"; label: string; icon: MoneyIconName };

const MOBILE_BOTTOM_NAV: MobileNavItem[] = [
  { kind: "route", path: "/", label: "Home", icon: "home" },
  { kind: "route", path: "/budget", label: "Budget", icon: "budget" },
  { kind: "add", label: "Add", icon: "plus" },
  { kind: "route", path: "/transactions", label: "Activity", icon: "activity" },
  { kind: "route", path: "/accounts", label: "Accounts", icon: "accounts" },
];

function ShellModal(props: { title: string; children: JSX.Element; onClose: () => void }) {
  return (
    <MoneyDialog title={props.title} onClose={props.onClose}>
      <div class="money-form">{props.children}</div>
    </MoneyDialog>
  );
}

export default function Layout(props: RouteSectionProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [showMobileMenu, setShowMobileMenu] = createSignal(false);
  const [showCmdBar, setShowCmdBar] = createSignal(false);
  const [transactionRequest, setTransactionRequest] = createSignal<OpenTransactionOptions | null>(
    null,
  );
  const [composerAccounts, setComposerAccounts] = createSignal<AccountRow[]>([]);
  const [composerCategories, setComposerCategories] = createSignal<CategoryRow[]>([]);
  const [composerLoading, setComposerLoading] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);

  loadSettings();

  function isActive(item: NavItem): boolean {
    const paths = item.activePaths ?? [item.path];
    return paths.some((path) =>
      path === "/" ? location.pathname === "/" : location.pathname.startsWith(path),
    );
  }

  async function loadComposerData(): Promise<void> {
    setComposerLoading(true);
    setComposerError(null);
    try {
      const [accountData, categoryData] = await Promise.all([api.accounts(), api.categories()]);
      setComposerAccounts(
        accountData.accounts.map(({ id, name, closed }) => ({ id, name, closed })),
      );
      setComposerCategories(
        categoryData.categories
          .filter((category) => !category.hidden)
          .map(({ id, name, group_name, isIncome }) => ({
            id,
            name,
            groupName: group_name ?? null,
            isIncome,
          })),
      );
    } catch (caught) {
      setComposerError(
        caught instanceof Error ? caught.message : "Could not prepare the transaction form",
      );
    } finally {
      setComposerLoading(false);
    }
  }

  function openTransaction(options: OpenTransactionOptions = {}): void {
    setTransactionRequest(options);
    void loadComposerData();
  }

  function openSearch(): void {
    setShowMobileMenu(false);
    setShowCmdBar(true);
  }

  createEffect(() => {
    if (!showMobileMenu()) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMobileMenu(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  createHotkey("Mod+K", openSearch);
  createHotkey("Mod+Shift+A", () => openTransaction());
  createHotkey("Mod+Z", async () => {
    await undo();
  });
  createHotkey("Mod+Shift+Z", async () => {
    await redo();
  });

  const shellActions = { openTransaction, openSearch };

  const currency = useCurrency();
  return (
    <MoneyShellProvider value={shellActions}>
      <div class="app-layout" data-currency={currency().code}>
        <aside class="sidebar">
          <div class="sidebar-header">
            <span class="sidebar-logo" aria-hidden="true">
              <span class="money-brand-mark">m</span>
            </span>
            <span class="sidebar-title">Money</span>
          </div>

          <nav class="sidebar-nav" aria-label="Primary navigation">
            <For each={PRIMARY_NAV}>
              {(item) => (
                <A href={item.path} class="nav-item" classList={{ active: isActive(item) }}>
                  <span class="nav-icon" aria-hidden="true">
                    <MoneyIcon name={item.icon} />
                  </span>
                  <span class="nav-label">{item.label}</span>
                </A>
              )}
            </For>

            <details class="sidebar-more" open={SECONDARY_NAV.some(isActive)}>
              <summary class="nav-item">
                <span class="nav-icon" aria-hidden="true">
                  <MoneyIcon name="more" />
                </span>
                <span class="nav-label">More</span>
              </summary>
              <div class="sidebar-more-items">
                <For each={SECONDARY_NAV}>
                  {(item) => (
                    <A
                      href={item.path}
                      class="nav-item nav-item-secondary"
                      classList={{ active: isActive(item) }}
                    >
                      <span class="nav-icon" aria-hidden="true">
                        <MoneyIcon name={item.icon} />
                      </span>
                      <span class="nav-label">{item.label}</span>
                    </A>
                  )}
                </For>
              </div>
            </details>
          </nav>

          <div class="sidebar-footer">
            <div class="sidebar-undo">
              <button
                type="button"
                class="btn btn-icon btn-ghost btn-sm"
                disabled={historyBusy() || undoStack().length === 0}
                onClick={async () => {
                  await undo();
                }}
                aria-label="Undo last change"
                title="Undo (Ctrl+Z)"
              >
                ↶
              </button>
              <button
                type="button"
                class="btn btn-icon btn-ghost btn-sm"
                disabled={historyBusy() || redoStack().length === 0}
                onClick={async () => {
                  await redo();
                }}
                aria-label="Redo last change"
                title="Redo (Ctrl+Shift+Z)"
              >
                ↷
              </button>
              <span class="sidebar-undo-label">
                {undoStack().length > 0 ? undoStack()[undoStack().length - 1].label : "No changes"}
              </span>
            </div>
            <button type="button" class="btn btn-ghost btn-sm sidebar-command" onClick={openSearch}>
              <kbd>⌘K</kbd>
              Search &amp; commands
            </button>
            <details class="sidebar-session">
              <summary>
                Session <MoneyIcon name="more" size={16} />
              </summary>
              <div class="build-marker" title={BUILD_INFO.tooltip}>
                {BUILD_INFO.label}
              </div>
              <form method="post" action="/api/auth/logout">
                <button type="submit" class="btn btn-ghost btn-sm">
                  Sign out
                </button>
              </form>
            </details>
          </div>
        </aside>

        <div class="desktop-toolbar" aria-label="Quick actions">
          <span class="suite-label">
            Shedflare <span>/</span> Money
          </span>
          <button type="button" class="toolbar-search" onClick={openSearch}>
            <MoneyIcon name="search" size={17} />
            Search<kbd>⌘ K</kbd>
          </button>
          <button type="button" class="btn btn-primary" onClick={() => openTransaction()}>
            <MoneyIcon name="plus" size={17} />
            Add
          </button>
        </div>

        <header class="mobile-top-bar">
          <span class="mobile-title">Money</span>
          <button
            type="button"
            class="btn btn-icon btn-ghost"
            onClick={openSearch}
            aria-label="Search"
          >
            <MoneyIcon name="search" />
          </button>
          <button
            type="button"
            class="btn btn-icon btn-ghost"
            onClick={() => setShowMobileMenu(true)}
            aria-label="Open more navigation"
          >
            <MoneyIcon name="more" />
          </button>
        </header>

        <Show when={showMobileMenu()}>
          <div class="mobile-menu-overlay" onClick={() => setShowMobileMenu(false)}>
            <div
              class="mobile-menu"
              role="dialog"
              aria-modal="true"
              aria-label="More navigation"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="mobile-menu-header">
                <strong>More</strong>
                <button
                  type="button"
                  class="btn btn-icon btn-ghost"
                  onClick={() => setShowMobileMenu(false)}
                  aria-label="Close menu"
                >
                  ×
                </button>
              </div>
              <For each={[PRIMARY_NAV[4], ...SECONDARY_NAV]}>
                {(item) => (
                  <button
                    type="button"
                    class="mobile-menu-item"
                    classList={{ active: isActive(item) }}
                    onClick={() => {
                      navigate(item.path);
                      setShowMobileMenu(false);
                    }}
                  >
                    <MoneyIcon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                )}
              </For>
              <div class="mobile-menu-divider" />
              <button
                type="button"
                class="mobile-menu-item"
                disabled={historyBusy() || undoStack().length === 0}
                onClick={async () => {
                  await undo();
                  setShowMobileMenu(false);
                }}
              >
                <span aria-hidden="true">↶</span>
                <span>Undo last change</span>
              </button>
              <button type="button" class="mobile-menu-item" onClick={openSearch}>
                <span aria-hidden="true">⌕</span>
                <span>Search &amp; commands</span>
              </button>
              <form method="post" action="/api/auth/logout">
                <button type="submit" class="mobile-menu-item">
                  <span aria-hidden="true">⇥</span>
                  <span>Sign out</span>
                </button>
              </form>
            </div>
          </div>
        </Show>

        <main class="main-content">{props.children}</main>

        <nav class="bottom-tab-bar" aria-label="Primary mobile navigation">
          <For each={MOBILE_BOTTOM_NAV}>
            {(item) => (
              <button
                type="button"
                class="bottom-tab"
                classList={{
                  active:
                    item.kind === "route" &&
                    (item.path === "/"
                      ? location.pathname === "/"
                      : location.pathname.startsWith(item.path)),
                  "bottom-tab-add": item.kind === "add",
                }}
                onClick={() => {
                  if (item.kind === "add") openTransaction();
                  else navigate(item.path);
                }}
              >
                <span class="tab-icon" aria-hidden="true">
                  <MoneyIcon name={item.icon} />
                </span>
                <span class="tab-label">{item.label}</span>
              </button>
            )}
          </For>
        </nav>

        <Show when={showCmdBar()}>
          <CommandBar open={showCmdBar()} onClose={() => setShowCmdBar(false)} />
        </Show>

        <Show when={transactionRequest()}>
          {(request) => (
            <Show
              when={!composerLoading() && !composerError()}
              fallback={
                <ShellModal title="Add transaction" onClose={() => setTransactionRequest(null)}>
                  <Show
                    when={!composerLoading()}
                    fallback={
                      <p class="text-muted" role="status">
                        Loading…
                      </p>
                    }
                  >
                    <div class="form-error">{composerError()}</div>
                    <div class="form-actions">
                      <button type="button" class="btn btn-primary" onClick={loadComposerData}>
                        Try again
                      </button>
                    </div>
                  </Show>
                </ShellModal>
              }
            >
              <Show
                when={composerAccounts().some((account) => !account.closed)}
                fallback={
                  <ShellModal title="Add an account" onClose={() => setTransactionRequest(null)}>
                    <div class="form-actions">
                      <button
                        type="button"
                        class="btn btn-primary"
                        onClick={() => {
                          setTransactionRequest(null);
                          navigate("/accounts?new=1");
                        }}
                      >
                        Add account
                      </button>
                    </div>
                  </ShellModal>
                }
              >
                <AddTransactionModal
                  accounts={composerAccounts()}
                  categories={composerCategories()}
                  initialAccountId={request().initialAccountId}
                  initialCategoryId={request().initialCategoryId}
                  onClose={() => setTransactionRequest(null)}
                  onCreated={request().onCreated}
                />
              </Show>
            </Show>
          )}
        </Show>

        <ToastCenter />
      </div>
    </MoneyShellProvider>
  );
}
