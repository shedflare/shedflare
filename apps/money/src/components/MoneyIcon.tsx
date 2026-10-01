import { Switch, Match } from "solid-js";

export type MoneyIconName =
  | "home"
  | "budget"
  | "activity"
  | "accounts"
  | "calendar"
  | "search"
  | "plus"
  | "arrow"
  | "move"
  | "close"
  | "settings"
  | "more"
  | "check"
  | "chevron"
  | "copy"
  | "chart";

export default function MoneyIcon(props: { name: MoneyIconName; size?: number }) {
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
      <Switch>
        <Match when={props.name === "home"}>
          <path d="m3 10 9-7 9 7v10H15v-7H9v7H3Z" />
        </Match>
        <Match when={props.name === "budget"}>
          <rect x="3" y="5" width="18" height="15" rx="3" />
          <path d="M3 10h18M8 3v4m8-4v4M8 14h2m4 0h2m-8 3h2" />
        </Match>
        <Match when={props.name === "activity"}>
          <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
        </Match>
        <Match when={props.name === "accounts"}>
          <rect x="3" y="5" width="18" height="15" rx="3" />
          <path d="M3 10h18m-5 5h2" />
        </Match>
        <Match when={props.name === "calendar"}>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4m8-4v4m-8 7h1m3 0h1m3 0h1m-9 3h1m3 0h1" />
        </Match>
        <Match when={props.name === "search"}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </Match>
        <Match when={props.name === "plus"}>
          <path d="M12 5v14M5 12h14" />
        </Match>
        <Match when={props.name === "arrow"}>
          <path d="M5 12h14m-5-5 5 5-5 5" />
        </Match>
        <Match when={props.name === "move"}>
          <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />
        </Match>
        <Match when={props.name === "close"}>
          <path d="m6 6 12 12M6 18 18 6" />
        </Match>
        <Match when={props.name === "settings"}>
          <path d="M4 7h16M4 17h16" />
          <circle cx="8" cy="7" r="3" fill="var(--bg-card)" />
          <circle cx="16" cy="17" r="3" fill="var(--bg-card)" />
        </Match>
        <Match when={props.name === "more"}>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </Match>
        <Match when={props.name === "check"}>
          <path d="m5 12 4 4L19 6" />
        </Match>
        <Match when={props.name === "chevron"}>
          <path d="m6 9 6 6 6-6" />
        </Match>
        <Match when={props.name === "copy"}>
          <rect x="8" y="8" width="12" height="13" rx="2" />
          <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </Match>
        <Match when={props.name === "chart"}>
          <path d="M4 20V4m0 16h16M8 15l4-5 4 3 4-7" />
        </Match>
      </Switch>
    </svg>
  );
}
