import { Show, createMemo, createEffect, createSignal, onCleanup } from "solid-js";
import { useDrive } from "../context";
import type { DriveFile } from "../types";
import CliCommandDialog from "./CliCommandDialog";

export default function ContextMenu() {
  const ctx = useDrive();
  const [downloadFile, setDownloadFile] = createSignal<DriveFile | null>(null);

  const file = createMemo(() => {
    const menu = ctx.contextMenu();
    if (!menu) return undefined;
    return ctx.files().find((f) => f.id === menu.fileId);
  });

  // Click-away handler
  createEffect(() => {
    const menu = ctx.contextMenu();
    if (menu) {
      const handler = () => ctx.setContextMenu(null);
      document.addEventListener("click", handler);
      onCleanup(() => document.removeEventListener("click", handler));
    }
  });

  return (
    <>
      <Show when={downloadFile()} keyed>
        {(selected) => (
          <CliCommandDialog
            transfer={{ kind: "download", file: selected }}
            onClose={() => setDownloadFile(null)}
          />
        )}
      </Show>
      <Show when={ctx.contextMenu() && file()}>
        {(menuFile) => {
          const menu = ctx.contextMenu()!;
          return (
            <div
              class="context-menu"
              style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                class="context-menu-item"
                onClick={() => {
                  ctx.download(menuFile());
                  ctx.setContextMenu(null);
                }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z" />
                  <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z" />
                </svg>
                Download
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  setDownloadFile(menuFile());
                  ctx.setContextMenu(null);
                }}
              >
                CLI download
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  ctx.setEditingId(menuFile().id);
                  ctx.setContextMenu(null);
                }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" />
                </svg>
                Rename
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  void ctx.setFilePublic(menuFile(), !menuFile().isPublic);
                  ctx.setContextMenu(null);
                }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.5 6a3.5 3.5 0 1 1 6.7 1.4.5.5 0 1 1-.9-.4 2.5 2.5 0 1 0-3.25 3.25.5.5 0 1 1-.4.92A3.5 3.5 0 0 1 4.5 6z" />
                  <path d="M6.75 8.75a.5.5 0 0 1 0-.7l1.3-1.3a.5.5 0 0 1 .7.7l-1.3 1.3a.5.5 0 0 1-.7 0zm1.1 3.72a3.5 3.5 0 1 0 1.48-6.7.5.5 0 0 0-.18.98 2.5 2.5 0 1 1-1.9 1.9.5.5 0 1 0-.98-.18 3.5 3.5 0 0 0 1.58 4z" />
                </svg>
                {menuFile().isPublic ? "Make private" : "Make public"}
              </button>
              <Show when={menuFile().isPublic}>
                <button
                  class="context-menu-item"
                  onClick={() => {
                    void ctx.copyPublicLink(menuFile());
                    ctx.setContextMenu(null);
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.5 6a3.5 3.5 0 1 1 5.45 2.9.5.5 0 1 1-.6-.8A2.5 2.5 0 1 0 5.9 4.65a.5.5 0 1 1-.8-.6A3.48 3.48 0 0 1 4.5 6z" />
                    <path d="M11.5 10a3.5 3.5 0 1 1-5.45-2.9.5.5 0 1 1 .6.8 2.5 2.5 0 1 0 3.45 3.45.5.5 0 0 1 .8.6 3.48 3.48 0 0 1 .6-1.95z" />
                    <path d="M6.65 10.35a.5.5 0 0 1 0-.7l2.5-2.5a.5.5 0 0 1 .7.7l-2.5 2.5a.5.5 0 0 1-.7 0z" />
                  </svg>
                  Copy public link
                </button>
              </Show>
              <button
                class="context-menu-item context-menu-item-danger"
                onClick={() => {
                  ctx.setPendingDeleteId(menuFile().id);
                  ctx.setContextMenu(null);
                }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
                  <path
                    fill-rule="evenodd"
                    d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"
                  />
                </svg>
                Delete
              </button>
            </div>
          );
        }}
      </Show>
    </>
  );
}
