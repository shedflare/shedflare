import { Show } from "solid-js";
import { CATEGORY_ICONS, type CategoryIcon } from "../domain/category-icons";
import { categoryTone } from "../lib/budget-view";

export function CategoryGlyph(props: { icon: CategoryIcon; size?: number }) {
  return (
    <svg
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={CATEGORY_ICONS[props.icon].path} />
    </svg>
  );
}

export default function CategoryBadge(props: {
  name: string;
  icon?: CategoryIcon | null;
  small?: boolean;
}) {
  return (
    <span
      class={`category-monogram tone-${categoryTone(props.name)}`}
      classList={{ "category-badge-small": props.small }}
      aria-hidden="true"
    >
      <Show when={props.icon} fallback={props.name.slice(0, 1).toUpperCase() || "A"}>
        {(icon) => <CategoryGlyph icon={icon()} size={props.small ? 17 : 20} />}
      </Show>
    </span>
  );
}
