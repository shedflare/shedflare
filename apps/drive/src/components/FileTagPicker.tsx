import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { useDrive } from "../context";
import type { DriveFile } from "../types";
import { MAX_FILE_TAGS, normalizeTag } from "../shared/tags";
import TagLoadStatus from "./TagLoadStatus";

export default function FileTagPicker(props: { file: DriveFile; children: JSX.Element }) {
  const ctx = useDrive();
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [operation, setOperation] = createSignal<
    | { status: "idle" | "saving" }
    | { status: "error"; message: string; tags: string[]; closeAfter: boolean }
  >({ status: "idle" });
  const busy = () => operation().status === "saving";
  const failure = () => {
    const state = operation();
    return state.status === "error" ? state : undefined;
  };
  const listId = createUniqueId();
  let container!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let input: HTMLInputElement | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const name = () => normalizeTag(query());
  const invalid = () => name().includes(",");
  const full = () => props.file.tags.length >= MAX_FILE_TAGS;
  const options = createMemo(() => {
    const existing = ctx
      .tags()
      .filter((tag) => tag.name.includes(name()))
      .map((tag) => ({
        name: tag.name,
        create: false,
        assigned: props.file.tags.includes(tag.name),
      }));
    if (
      name() &&
      !invalid() &&
      !ctx.tags().some((tag) => tag.name === name()) &&
      !props.file.tags.includes(name())
    ) {
      existing.push({ name: name(), create: true, assigned: false });
    }
    return existing;
  });
  const selectable = () =>
    options()
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.assigned);
  const activeIndex = () =>
    selectable().some(({ index }) => index === active()) ? active() : selectable()[0]?.index;

  function close() {
    setOpen(false);
    trigger.focus();
  }
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
  });

  async function save(tags: string[], closeAfter = false) {
    if (busy()) return;
    setOperation({ status: "saving" });
    try {
      await ctx.setFileTags(props.file, tags);
      if (disposed) return;
      setOperation({ status: "idle" });
      setQuery("");
      setActive(0);
      if (closeAfter) close();
    } catch (error) {
      if (!disposed)
        setOperation({
          status: "error",
          message: error instanceof Error ? error.message : "Could not save tags.",
          tags,
          closeAfter,
        });
    }
  }
  function choose(index: number | undefined) {
    const option = index === undefined ? undefined : options()[index];
    if (!option || option.assigned || full() || busy()) return;
    void save([...props.file.tags, option.name], true);
  }

  return (
    <div
      class="detail-tag-editor"
      ref={(element) => {
        container = element;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open()) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div class="detail-tag-row">
        {props.children}
        <For each={props.file.tags}>
          {(tag) => (
            <button
              type="button"
              class="detail-tag"
              disabled={busy()}
              aria-label={`Remove tag ${tag}`}
              title={`Remove ${tag}`}
              onClick={() => void save(props.file.tags.filter((name) => name !== tag))}
            >
              <span>{tag}</span>
              <span aria-hidden="true" class="tag-remove">
                ×
              </span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="tag-add"
          ref={(element) => {
            trigger = element;
          }}
          aria-label="Add tag"
          aria-expanded={open()}
          aria-controls={`${listId}-picker`}
          onClick={() => {
            setOpen(!open());
            if (open()) {
              setQuery("");
              setActive(0);
              input?.focus();
            }
          }}
        >
          +
        </button>
      </div>
      <Show when={open()}>
        <div
          class="tag-picker"
          id={`${listId}-picker`}
          role="dialog"
          aria-label="Add a tag"
          aria-busy={busy()}
        >
          <input
            ref={(element) => {
              input = element;
            }}
            type="search"
            role="combobox"
            aria-label="Search or create a tag"
            placeholder="Search or create a tag…"
            autocomplete="off"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              activeIndex() === undefined ? undefined : `${listId}-${activeIndex()}`
            }
            value={query()}
            disabled={busy()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                choose(activeIndex());
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const choices = selectable();
                if (!choices.length) return;
                const current = choices.findIndex(({ index }) => index === activeIndex());
                const next =
                  (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) %
                  choices.length;
                setActive(choices[next].index);
                document
                  .getElementById(`${listId}-${choices[next].index}`)
                  ?.scrollIntoView?.({ block: "nearest" });
              }
            }}
          />
          <TagLoadStatus />
          <div class="tag-picker-options" id={listId} role="listbox" aria-label="Tags">
            <For each={options()}>
              {(option, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index()}`}
                  aria-selected={option.assigned}
                  disabled={busy() || option.assigned || full()}
                  classList={{ highlighted: activeIndex() === index() }}
                  onClick={() => choose(index())}
                >
                  <span>{option.create ? `Create “${option.name}”` : option.name}</span>
                  <Show when={option.assigned}>
                    <span aria-hidden="true">✓</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <Show when={!options().length && ctx.tagsState().status === "ready" && !invalid()}>
            <p class="filter-hint">Type a name to create a tag.</p>
          </Show>
          <Show when={invalid()}>
            <p class="filter-hint" role="alert">
              Tags cannot contain commas.
            </p>
          </Show>
          <Show when={full()}>
            <p class="filter-hint">Remove a tag before adding another (20 maximum).</p>
          </Show>
          <Show when={busy()}>
            <p class="filter-hint" role="status">
              Saving…
            </p>
          </Show>
        </div>
      </Show>
      <Show when={failure()}>
        {(failed) => (
          <p class="filter-hint tag-error" role="alert">
            {failed().message}{" "}
            <button
              type="button"
              class="text-button"
              onClick={() => void save(failed().tags, failed().closeAfter)}
            >
              Retry
            </button>
          </p>
        )}
      </Show>
    </div>
  );
}
