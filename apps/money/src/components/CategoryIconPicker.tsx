import { For } from "solid-js";
import { CATEGORY_ICON_NAMES, CATEGORY_ICONS, type CategoryIcon } from "../domain/category-icons";
import CategoryBadge, { CategoryGlyph } from "./CategoryBadge";

export default function CategoryIconPicker(props: {
  name: string;
  value: CategoryIcon | null;
  onChange: (icon: CategoryIcon | null) => void;
  disabled?: boolean;
}) {
  let picker: HTMLDetailsElement | undefined;
  function select(icon: CategoryIcon | null) {
    props.onChange(icon);
    if (picker) {
      picker.open = false;
      picker.querySelector<HTMLElement>("summary")?.focus();
    }
  }
  return (
    <details
      class="category-icon-picker"
      ref={(element) => {
        picker = element;
      }}
    >
      <summary
        aria-label="Choose category icon"
        aria-disabled={props.disabled}
        onClick={(event) => {
          if (props.disabled) event.preventDefault();
        }}
      >
        <CategoryBadge name={props.name} icon={props.value} />
        <span>Icon</span>
        <span class="icon-picker-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div class="category-icon-grid" aria-label="Category icons">
        <button
          type="button"
          aria-label="Use category initial"
          title="Use initial"
          aria-pressed={props.value === null}
          disabled={props.disabled}
          onClick={() => select(null)}
        >
          {props.name.slice(0, 1).toUpperCase() || "A"}
        </button>
        <For each={CATEGORY_ICON_NAMES}>
          {(icon) => (
            <button
              type="button"
              aria-label={`${CATEGORY_ICONS[icon].label} icon`}
              title={CATEGORY_ICONS[icon].label}
              aria-pressed={props.value === icon}
              disabled={props.disabled}
              onClick={() => select(icon)}
            >
              <CategoryGlyph icon={icon} />
            </button>
          )}
        </For>
      </div>
    </details>
  );
}
