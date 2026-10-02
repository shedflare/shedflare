import { onCleanup, onMount, type JSX } from "solid-js";
import MoneyIcon from "./MoneyIcon";

export default function MoneyDialog(props: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  drawer?: boolean;
  children: JSX.Element;
}) {
  let dialog: HTMLDialogElement | undefined;
  onMount(() => {
    const previous = document.activeElement;
    dialog?.showModal();
    onCleanup(() => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    });
  });
  return (
    <dialog
      ref={(element) => {
        dialog = element;
      }}
      class={props.drawer ? "money-dialog money-drawer" : "money-dialog"}
      aria-label={props.title}
      onCancel={(event) => {
        event.preventDefault();
        if (!props.busy) props.onClose();
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget || props.busy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          props.onClose();
      }}
    >
      <div class="money-dialog-header">
        <h2>{props.title}</h2>
        <button
          type="button"
          class="btn btn-icon btn-ghost"
          aria-label="Close"
          disabled={props.busy}
          onClick={props.onClose}
        >
          <MoneyIcon name="close" />
        </button>
      </div>
      {props.children}
    </dialog>
  );
}
