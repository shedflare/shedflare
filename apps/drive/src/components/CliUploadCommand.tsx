import { Show, createSignal } from "solid-js";
import CliCommandDialog from "./CliCommandDialog";

export default function CliUploadCommand() {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button type="button" class="btn top-bar-signout" onClick={() => setOpen(true)}>
        CLI upload
      </button>
      <Show when={open()}>
        <CliCommandDialog transfer={{ kind: "upload" }} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}
