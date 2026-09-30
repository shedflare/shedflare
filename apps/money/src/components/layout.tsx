import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { A, useLocation, useNavigate, type RouteSectionProps } from "@solidjs/router";
import { createHotkey } from "@tanstack/solid-hotkeys";
import CommandBar from "./CommandBar";
import AddTransactionModal from "./AddTransactionModal";
import ToastCenter from "./ToastCenter";
import { MoneyShellProvider, type OpenTransactionOptions } from "./MoneyShellContext";
import { undo, redo, undoStack, redoStack } from "../lib/undo-stack";
import { BUILD_INFO } from "../lib/build-info";
import { loadSettings } from "../lib/settings-store";
import { api } from "../lib/api";
import type { AccountsResponse, CategoriesResponse } from "../domain/schemas-client";

interface NavItem {
  path: string;
  label: string;
  icon: string;
  activePaths?: string[];
}

type AccountRow = Pick<AccountsResponse["accounts"][number], "id" | "name" | "closed">;
type CategoryRow = Pick<CategoriesResponse["categories"][number], "id" | "name"> & {
  groupName: string | null;
};

const PRIMARY_NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: "⌂" },
  { path: "/transactions", label: "Transactions", icon: "↔" },
  { path: "/budget", label: "Budget", icon: "◫", activePaths: ["/budget", "/categories"] },
  { path: "/accounts", label: "Accounts", icon: "▣", activePaths: ["/accounts"] },
  {
    path: "/schedules",
    label: "Automations",
    icon: "↻",
    activePaths: ["/schedules", "/rules"],
  },
];

const SECONDARY_NAV: NavItem[] = [
  { path: "/reports", label: "Reports", icon: "⌁" },
  { path: "/categories", label: "Categories & goals", icon: "▤" },
  { path: "/payees", label: "Payees", icon: "◎" },
  { path: "/rules", label: "Rules", icon: "⚙" },
  { path: "/tags", label: "Tags", icon: "◇" },
  { path: "/settings", label: "Settings & data", icon: "☷" },
];

type MobileNavItem =
  | { kind: "route"; path: string; label: string; icon: string }
  | { kind: "add"; label: string; icon: string };

const MOBILE_BOTTOM_NAV: MobileNavItem[] = [
  { kind: "route", path: "/", label: "Home", icon: "⌂" },
  { kind: "route", path: "/transactions", label: "Activity", icon: "↔" },
  { kind: "add", label: "Add", icon: "+" },
  { kind: "route", path: "/budget", label: "Budget", icon: "◫" },
  { kind: "route", path: "/accounts", label: "Accounts", icon: "▣" },
];

function ShellModal(props: { title: string; children: JSX.Element; onClose: () => void }) {
  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div
        class="modal shell-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="modal-header">
          <h2>{props.title}</h2>
          <button type="button" class="modal-close" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
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
        categoryData.categories.map(({ id, name, group_name }) => ({
          id,
          name,
          groupName: group_name ?? null,
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

  return (
    <MoneyShellProvider value={shellActions}>
      <div class="app-layout">
        <aside class="sidebar">
          <div class="sidebar-header">
            <span class="sidebar-logo" aria-hidden="true">
              💰
            </span>
            <span class="sidebar-title">Money</span>
          </div>

          <nav class="sidebar-nav" aria-label="Primary navigation">
            <For each={PRIMARY_NAV}>
              {(item) => (
                <A href={item.path} class="nav-item" classList={{ active: isActive(item) }}>
                  <span class="nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span class="nav-label">{item.label}</span>
                </A>
              )}
            </For>

            <details class="sidebar-more" open={SECONDARY_NAV.some(isActive)}>
              <summary class="nav-item">
                <span class="nav-icon" aria-hidden="true">
                  •••
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
                        {item.icon}
                      </span>
                      <span class="nav-label">{item.label}</span>
                    </A>
                  )}
                </For>
              </div>
            </details>
          </nav>

          <div class="sidebar-footer">
            <div class="build-marker" title={BUILD_INFO.tooltip}>
              {BUILD_INFO.label}
            </div>
            <div class="sidebar-undo">
              <button
                type="button"
                class="btn btn-icon btn-ghost btn-sm"
                disabled={undoStack().length === 0}
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
                disabled={redoStack().length === 0}
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
            <form method="post" action="/api/auth/logout">
              <button type="submit" class="btn btn-ghost btn-sm">
                Sign out
              </button>
            </form>
          </div>
        </aside>

        <div class="desktop-toolbar" aria-label="Quick actions">
          <button type="button" class="btn btn-secondary" onClick={openSearch}>
            Search
          </button>
          <button type="button" class="btn btn-primary" onClick={() => openTransaction()}>
            + Transaction
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
            ⌕
          </button>
          <button
            type="button"
            class="btn btn-icon btn-ghost"
            onClick={() => setShowMobileMenu(true)}
            aria-label="Open more navigation"
          >
            •••
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
              <For each={SECONDARY_NAV}>
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
                    <span aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                )}
              </For>
              <div class="mobile-menu-divider" />
              <button
                type="button"
                class="mobile-menu-item"
                disabled={undoStack().length === 0}
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
                  {item.icon}
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
                <ShellModal title="Add Transaction" onClose={() => setTransactionRequest(null)}>
                  <Show
                    when={!composerLoading()}
                    fallback={<p class="text-muted">Preparing accounts and categories…</p>}
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
                  <ShellModal
                    title="Create an account first"
                    onClose={() => setTransactionRequest(null)}
                  >
                    <p class="text-muted">A transaction needs an open account.</p>
                    <div class="form-actions">
                      <button
                        type="button"
                        class="btn btn-primary"
                        onClick={() => {
                          setTransactionRequest(null);
                          navigate("/accounts");
                        }}
                      >
                        Go to Accounts
                      </button>
                    </div>
                  </ShellModal>
                }
              >
                <AddTransactionModal
                  accounts={composerAccounts()}
                  categories={composerCategories()}
                  initialAccountId={request().initialAccountId}
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
