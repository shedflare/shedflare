import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { undo, historyBusy } from "../lib/undo-stack";
import {
  OPERATION_FEEDBACK_EVENT,
  OperationFeedbackSchema,
  type OperationFeedback,
} from "../lib/operation-feedback";
import * as Schema from "effect/Schema";

type Toast = OperationFeedback & { id: string };

export default function ToastCenter() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function dismiss(id: string): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function addToast(detail: OperationFeedback): void {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-2), { ...detail, id }]);
    timers.set(
      id,
      setTimeout(() => dismiss(id), detail.kind === "error" ? 7_000 : 5_000),
    );
  }

  onMount(() => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      addToast(Schema.decodeUnknownSync(OperationFeedbackSchema)(event.detail));
    };
    window.addEventListener(OPERATION_FEEDBACK_EVENT, listener);
    onCleanup(() => {
      window.removeEventListener(OPERATION_FEEDBACK_EVENT, listener);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    });
  });

  return (
    <div class="toast-region" aria-live="polite" aria-label="Notifications">
      <For each={toasts()}>
        {(toast) => (
          <div
            class="toast"
            classList={{ "toast-error": toast.kind === "error" }}
            role={toast.kind === "error" ? "alert" : "status"}
          >
            <span class="toast-icon" aria-hidden="true">
              {toast.kind === "error" ? "!" : "✓"}
            </span>
            <span class="toast-message">{toast.message}</span>
            <Show when={toast.undoable}>
              <button
                type="button"
                class="toast-action"
                disabled={historyBusy()}
                onClick={async () => {
                  dismiss(toast.id);
                  await undo();
                }}
              >
                Undo
              </button>
            </Show>
            <button
              type="button"
              class="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
