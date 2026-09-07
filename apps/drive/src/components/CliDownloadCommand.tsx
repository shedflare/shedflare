import { Show, createSignal } from "solid-js";
import type { DriveFile } from "../types";
import CliCommandDialog from "./CliCommandDialog";

export default function CliDownloadCommand(props: { file: DriveFile }) {
  const [file, setFile] = createSignal<DriveFile | null>(null);
  return (
    <>
      <button type="button" class="btn" onClick={() => setFile(props.file)}>
        CLI download
      </button>
      <Show when={file()} keyed>
        {(selected) => (
          <CliCommandDialog
            transfer={{ kind: "download", file: selected }}
            onClose={() => setFile(null)}
          />
        )}
      </Show>
    </>
  );
}
