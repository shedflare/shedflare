import { For } from "solid-js";
import { useDrive } from "../context";
import TagLoadStatus from "./TagLoadStatus";

export default function TagStrip() {
  const ctx = useDrive();

  return (
    <section class="filter-section" aria-label="Tag filters">
      <span class="filter-label">Tags</span>
      <div class="tag-strip" role="group" aria-label="Filter by tag">
        <button
          type="button"
          aria-pressed={ctx.selectedTag() === ""}
          classList={{ active: ctx.selectedTag() === "" }}
          onClick={() => ctx.setSelectedTag("")}
        >
          All
        </button>
        <For each={ctx.tags()}>
          {(tag) => (
            <button
              type="button"
              aria-pressed={ctx.selectedTag() === tag.name}
              classList={{ active: ctx.selectedTag() === tag.name }}
              onClick={() => ctx.setSelectedTag(ctx.selectedTag() === tag.name ? "" : tag.name)}
            >
              {tag.name} <span>{tag.count}</span>
            </button>
          )}
        </For>
      </div>
      <TagLoadStatus />
    </section>
  );
}
