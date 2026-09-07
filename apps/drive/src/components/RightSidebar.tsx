import { Show, createEffect, onCleanup } from "solid-js";
import { useDrive } from "../context";
import FileDetailPanel from "./FileDetailPanel";

export default function RightSidebar() {
  const ctx = useDrive();
  const isOpen = () => !!ctx.selectedFileId() && !!ctx.selectedFile();
  const isVisible = () => isOpen() && !ctx.rightSidebarCollapsed();

  // Click-outside handler
  function handleClick(e: MouseEvent) {
    // Portaled dialogs are outside the sidebar DOM but still own the current file selection.
    if (!isVisible() || document.querySelector("dialog[open]")) return;
    const sidebar = document.querySelector(".right-sidebar");
    if (sidebar && e.target instanceof Node && !sidebar.contains(e.target)) {
      ctx.setSelectedFileId("");
    }
  }

  createEffect(() => {
    if (isVisible()) {
      document.addEventListener("mousedown", handleClick);
      onCleanup(() => document.removeEventListener("mousedown", handleClick));
    }
  });

  return (
    <Show when={isOpen()}>
      <Show
        when={!ctx.rightSidebarCollapsed()}
        fallback={
          <button
            class="right-sidebar-peek"
            onClick={() => ctx.setRightSidebarCollapsed(false)}
            title="Open details"
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
            </svg>
          </button>
        }
      >
        <div class="right-sidebar-backdrop" onClick={() => ctx.setSelectedFileId("")} />
        <aside class="right-sidebar open">
          <button
            class="right-sidebar-collapse"
            onClick={() => ctx.setRightSidebarCollapsed(true)}
            title="Collapse details"
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
            </svg>
          </button>
          <button class="right-sidebar-close" onClick={() => ctx.setSelectedFileId("")}>
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
            </svg>
          </button>
          <FileDetailPanel />
        </aside>
      </Show>
    </Show>
  );
}
