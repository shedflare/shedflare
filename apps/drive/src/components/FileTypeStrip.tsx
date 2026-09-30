import { For } from "solid-js";
import { useDrive } from "../context";
import { FILE_TYPES } from "../shared/file-types";

export default function FileTypeStrip() {
  const ctx = useDrive();
  const options = [
    { value: "", label: "All" },
    ...FILE_TYPES,
    { value: "other", label: "Other" },
  ] as const;
  return (
    <section class="filter-section" aria-label="File type filters">
      <span class="filter-label">File type</span>
      <div class="tag-strip" role="group" aria-label="File type">
        <For each={options}>
          {(type) => (
            <button
              type="button"
              classList={{ active: ctx.selectedFileType() === type.value }}
              aria-pressed={ctx.selectedFileType() === type.value}
              onClick={() =>
                ctx.setSelectedFileType(ctx.selectedFileType() === type.value ? "" : type.value)
              }
            >
              {type.label}
            </button>
          )}
        </For>
      </div>
    </section>
  );
}
