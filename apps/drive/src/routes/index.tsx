import { Show } from "solid-js";
import { DriveProvider, useDrive } from "../context";
import LeftSidebar from "../components/LeftSidebar";
import RightSidebar from "../components/RightSidebar";
import ViewToolbar from "../components/ViewToolbar";
import FileGrid from "../components/FileGrid";
import FileList from "../components/FileList";
import DeleteConfirm from "../components/DeleteConfirm";
import ToastContainer from "../components/ToastContainer";
import ContextMenu from "../components/ContextMenu";
import CliUploadCommand from "../components/CliUploadCommand";
import { BUILD_INFO } from "../lib/build-info";

function DriveShell() {
  const ctx = useDrive();

  return (
    <>
      {/* ── Top Bar ─────────────────────────── */}
      <header class="top-bar">
        <div class="top-bar-brand">
          <span class="top-bar-dot" />
          <span class="top-bar-title">Shedflare Drive</span>
        </div>
        <Show when={!ctx.checkingSession() && ctx.userEmail()}>
          <div class="top-bar-owner">
            <CliUploadCommand />
            <a class="btn top-bar-signout" href="/public">
              Public files
            </a>
            <span class="build-marker" title={BUILD_INFO.tooltip}>
              {BUILD_INFO.label}
            </span>
            <span class="top-bar-email">{ctx.userEmail()}</span>
            <form method="post" action="/api/auth/logout">
              <button class="btn top-bar-signout">Sign out</button>
            </form>
          </div>
        </Show>
      </header>

      {/* ── Main Layout ─────────────────────── */}
      <Show when={!ctx.checkingSession() && ctx.userEmail()}>
        <div class="drive-layout">
          <LeftSidebar />

          <Show when={ctx.leftSidebarOpen()}>
            <button
              type="button"
              class="left-sidebar-backdrop"
              aria-label="Close navigation"
              onClick={() => ctx.setLeftSidebarOpen(false)}
            />
          </Show>

          {/* Sidebar toggle */}
          <button
            type="button"
            class="sidebar-toggle"
            onClick={() => ctx.setLeftSidebarOpen(!ctx.leftSidebarOpen())}
            title={ctx.leftSidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
            aria-label={ctx.leftSidebarOpen() ? "Close navigation" : "Open navigation"}
            aria-expanded={ctx.leftSidebarOpen()}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="currentColor"
              classList={{ flipped: !ctx.leftSidebarOpen() }}
            >
              <path
                fill-rule="evenodd"
                d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"
              />
            </svg>
          </button>

          <main
            class="main-content"
            onClick={() => {
              if (ctx.selectedFileId()) ctx.setSelectedFileId("");
            }}
          >
            <ViewToolbar />

            <Show when={ctx.viewMode() === "grid"} fallback={<FileList />}>
              <FileGrid />
            </Show>

            <Show when={ctx.hasMore()}>
              <div class="load-more">
                <button class="btn" onClick={() => void ctx.loadMore()}>
                  Load more
                </button>
              </div>
            </Show>
          </main>

          <RightSidebar />
        </div>
      </Show>

      {/* ── Session / Auth Overlays ─────────── */}
      <Show when={ctx.checkingSession()}>
        <div class="session-overlay">
          <div class="session-overlay-card">
            <div class="session-spinner" />
            <p>Checking your Shedflare Drive session…</p>
          </div>
        </div>
      </Show>

      <Show when={!ctx.checkingSession() && ctx.unauthorized()}>
        <div class="session-overlay">
          <div class="session-overlay-card">
            <p>Sign in with the central Shedflare auth worker to open your private drive.</p>
            <span class="auth-buttons">
              <a class="btn" href="/public">
                Public files
              </a>
              <button type="button" class="btn btn-primary" onClick={ctx.signIn}>
                Sign in
              </button>
            </span>
          </div>
        </div>
      </Show>

      <Show when={ctx.error()}>
        <div class="session-overlay">
          <div class="session-overlay-card session-overlay-error">{ctx.error()}</div>
        </div>
      </Show>

      {/* ── Persistent Overlays ──────────────── */}
      <DeleteConfirm />
      <ToastContainer />
      <ContextMenu />
    </>
  );
}

export default function Home() {
  return (
    <DriveProvider>
      <DriveShell />
    </DriveProvider>
  );
}
