import { Show } from "solid-js";
import { useDrive } from "../context";

export default function TagLoadStatus() {
  const ctx = useDrive();
  const error = () => {
    const state = ctx.tagsState();
    return state.status === "error" ? state.message : "";
  };
  return (
    <>
      <Show when={ctx.tagsState().status === "loading"}>
        <p class="filter-hint" role="status">
          Loading tags…
        </p>
      </Show>
      <Show when={error()}>
        <div class="filter-hint" role="alert">
          {error()}{" "}
          <button
            type="button"
            class="text-button"
            onClick={() => void ctx.loadTags().catch(() => {})}
          >
            Retry
          </button>
        </div>
      </Show>
    </>
  );
}
