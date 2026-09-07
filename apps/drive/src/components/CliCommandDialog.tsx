import { Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { requestJson, useDrive } from "../context";
import {
  CliDownloadCommandResponse,
  SecureUploadCommandResponse,
  type DriveFile,
} from "../shared/schema";
import { defaultDownloadPath, downloadCommand, uploadCommand } from "../lib/cli-commands";

type Transfer = { kind: "upload" } | { kind: "download"; file: Pick<DriveFile, "id" | "name"> };
type CommandState =
  | { status: "loading" }
  | { status: "ready"; url: string; expiresAt: string }
  | { status: "failed"; message: string };

export default function CliCommandDialog(props: { transfer: Transfer; onClose: () => void }) {
  const ctx = useDrive();
  // The opener supplies a snapshot so changing the selected file cannot retarget this command.
  const transfer = props.transfer;
  const title = transfer.kind === "upload" ? "CLI upload" : "CLI download";
  const titleId = createUniqueId();
  const [path, setPath] = createSignal(
    transfer.kind === "download" ? defaultDownloadPath(transfer.file.name) : "",
  );
  const [expiresInSeconds, setExpiresInSeconds] = createSignal(120);
  const [state, setState] = createSignal<CommandState>({ status: "loading" });
  const [now, setNow] = createSignal(Date.now());
  const ready = createMemo(() => {
    const current = state();
    return current.status === "ready" ? current : null;
  });
  const failure = createMemo(() => {
    const current = state();
    return current.status === "failed" ? current.message : "";
  });
  const expired = () => {
    const current = ready();
    return current ? Date.parse(current.expiresAt) <= now() : false;
  };
  const validPath = () => path().length > 0 && !path().endsWith("/") && !/[\r\n\0]/u.test(path());
  const command = createMemo(() => {
    const current = ready();
    if (!current) return "";
    return transfer.kind === "upload"
      ? uploadCommand({ clientUrl: current.url, path: path() || "<path-to-file>" })
      : downloadCommand({ downloadUrl: current.url, path: path() || "<save-as-path>" });
  });
  let dialog: HTMLDialogElement | undefined;
  let pathInput: HTMLInputElement | undefined;
  let disposed = false;

  async function createCommand() {
    setState({ status: "loading" });
    try {
      const init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresInSeconds: expiresInSeconds() }),
      };
      const result =
        transfer.kind === "upload"
          ? await requestJson(
              "/api/secure-uploads/command",
              SecureUploadCommandResponse,
              init,
            ).then((value) => ({ url: value.clientUrl, expiresAt: value.expiresAt }))
          : await requestJson(
              `/api/files/${encodeURIComponent(transfer.file.id)}/download-command`,
              CliDownloadCommandResponse,
              init,
            ).then((value) => ({ url: value.downloadUrl, expiresAt: value.expiresAt }));
      if (!disposed) {
        setNow(Date.now());
        setState({ status: "ready", ...result });
      }
    } catch (cause) {
      if (!disposed)
        setState({
          status: "failed",
          message: cause instanceof Error ? cause.message : "Could not create a command. Retry.",
        });
    }
  }

  async function copyCommand() {
    if (!ready() || expired() || !validPath()) return;
    try {
      await navigator.clipboard.writeText(command());
      ctx.addToast(`${title} command copied`, "success");
    } catch {
      ctx.addToast("Select and copy the command manually", "info");
    }
  }

  onMount(() => {
    dialog?.showModal();
    pathInput?.focus();
    void createCommand();
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => {
    disposed = true;
    dialog?.close();
  });

  return (
    <Portal>
      <dialog
        ref={(element) => {
          dialog = element;
        }}
        class="secure-command-modal"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          props.onClose();
        }}
        onClick={(event) => {
          if (event.target === dialog) {
            const rect = dialog.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              props.onClose();
          }
        }}
      >
        <div class="secure-command-heading">
          <div>
            <h3 id={titleId}>{title}</h3>
            <p>
              {transfer.kind === "upload"
                ? "Enter the file’s path on your computer, then copy and run the command. Uploads are private and limited to 500 MB."
                : `Save ${transfer.file.name} from your terminal. This command grants temporary access to this file; it stays private.`}
            </p>
          </div>
          <button
            type="button"
            class="secure-command-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <label class="cli-command-path">
          {transfer.kind === "upload" ? "Local file path" : "Save as path"}
          <input
            ref={(element) => {
              pathInput = element;
            }}
            value={path()}
            onInput={(event) => setPath(event.currentTarget.value)}
            placeholder="~/Downloads/report.pdf"
            spellcheck={false}
            autocomplete="off"
          />
        </label>
        <p class="secure-command-expiry">
          Include the filename. Spaces and ~/ are supported; no extra quotes needed.
        </p>
        <Show when={state().status === "loading"}>
          <div class="secure-command-loading" role="status">
            Creating a short-lived command…
          </div>
        </Show>
        <Show when={failure()}>
          <p class="cli-command-error" role="alert">
            {failure()}
          </p>
        </Show>
        <Show when={ready()}>
          {(current) => (
            <>
              <textarea
                class="secure-command-value"
                aria-label="CLI command"
                readOnly
                rows={5}
                value={command()}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p class="secure-command-expiry" role="status">
                {expired()
                  ? "This command has expired. Create a new one to continue."
                  : `Start ${transfer.kind === "upload" ? "the upload" : "the download"} before ${new Date(current().expiresAt).toLocaleTimeString()}. A started transfer can finish after that.`}
              </p>
            </>
          )}
        </Show>
        <div class="secure-command-actions">
          <label>
            Valid for
            <select
              value={expiresInSeconds()}
              disabled={state().status === "loading"}
              onChange={(event) => {
                setExpiresInSeconds(Number(event.currentTarget.value));
                void createCommand();
              }}
            >
              <option value={120}>2 minutes</option>
              <option value={300}>5 minutes</option>
              <option value={600}>10 minutes</option>
            </select>
          </label>
          <button
            type="button"
            class="btn"
            disabled={state().status === "loading"}
            onClick={() => void createCommand()}
          >
            {failure() ? "Retry" : "Create new"}
          </button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={!ready() || expired() || !validPath()}
            onClick={() => void copyCommand()}
          >
            Copy command
          </button>
        </div>
      </dialog>
    </Portal>
  );
}
