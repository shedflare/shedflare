import { createMemo } from "solid-js";
import MoneyIcon from "./MoneyIcon";
import { previousPerformance } from "../lib/monthly-plan";
import type { BudgetCategory } from "../lib/budget-view";
import { useCurrency } from "../lib/currency";
import { useDateFormat } from "../lib/date-format";
import { usePrivacyMode } from "../lib/privacy";

export default function BudgetReference(props: {
  id: string;
  month: string;
  category: BudgetCategory;
  disabled: boolean;
  onCopy: () => void;
}) {
  const fmt = useCurrency();
  const df = useDateFormat();
  const privacy = usePrivacyMode();
  const result = createMemo(() => previousPerformance(props.category));
  const percentage = createMemo(() =>
    result().budgeted > 0
      ? Math.min(100, Math.max(0, (result().spent / result().budgeted) * 100))
      : result().spent > 0
        ? 100
        : 0,
  );
  const description = () =>
    privacy().enabled
      ? `${df().formatMonth(props.month)}: amounts hidden`
      : `${df().formatMonth(props.month)}: ${fmt().formatCents(result().spent)} spent of ${fmt().formatCents(result().budgeted)} budget`;
  return (
    <div id={props.id} class="budget-reference">
      <span class="budget-reference-month">{df().formatMonth(props.month)}</span>
      <button
        type="button"
        class="budget-reference-copy"
        aria-label={`Copy last month's budget for ${props.category.categoryName}`}
        title={privacy().enabled ? "Copy" : `Copy ${fmt().formatCents(result().budgeted)}`}
        disabled={props.disabled}
        onClick={props.onCopy}
      >
        <MoneyIcon name="copy" size={15} />
        Copy
      </button>
      <div
        class={`budget-reference-amounts ${privacy().blurClass()}`}
        aria-label={description()}
        title={description()}
      >
        <strong classList={{ "is-negative": result().status === "over" }}>
          {fmt().formatCents(result().spent)}
        </strong>
        <span aria-hidden="true">/</span>
        <span>{fmt().formatCents(result().budgeted)}</span>
      </div>
      <div
        class={`budget-reference-track ${privacy().blurClass()}`}
        role="img"
        aria-label={description()}
      >
        <span
          classList={{ "was-over": result().status === "over" }}
          style={{ width: `${percentage()}%` }}
        />
      </div>
    </div>
  );
}
