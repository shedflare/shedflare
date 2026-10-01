import { createMemo, For, Show } from "solid-js";
import CategoryBadge from "./CategoryBadge";
import MoneyIcon from "./MoneyIcon";
import { activityEntries } from "../lib/activity-view";
import { useCurrency } from "../lib/currency";
import { usePrivacyMode } from "../lib/privacy";
import { formatCalendarDate, parseCalendarDate } from "../domain/types";
import type { CategoriesResponse, TransactionsResponse } from "../domain/schemas-client";

export type ActivityTransaction = TransactionsResponse["transactions"][number];
export type ActivityCategory = CategoriesResponse["categories"][number];

export default function ActivityFeed(props: {
  transactions: readonly ActivityTransaction[];
  categories: readonly ActivityCategory[];
  onSelect: (id: string) => void;
  hideAccount?: boolean;
}) {
  const fmt = useCurrency();
  const privacy = usePrivacyMode();
  const groups = createMemo(() => {
    const dates = new Map<string, ActivityTransaction[]>();
    for (const transaction of activityEntries(props.transactions).toSorted(
      (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    )) {
      const rows = dates.get(transaction.date) ?? [];
      rows.push(transaction);
      dates.set(transaction.date, rows);
    }
    return [...dates].map(([date, rows]) => ({ date, rows }));
  });
  function dateLabel(date: string) {
    const today = new Date();
    if (date === formatCalendarDate(today)) return "Today";
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (date === formatCalendarDate(yesterday)) return "Yesterday";
    const parsed = parseCalendarDate(date);
    if (!parsed) return date;
    const options: Intl.DateTimeFormatOptions = {
      weekday: "short",
      day: "numeric",
      month: "short",
    };
    if (parsed.getFullYear() !== today.getFullYear()) options.year = "numeric";
    return new Intl.DateTimeFormat(fmt().locale, options).format(parsed);
  }
  return (
    <div class="activity-feed">
      <For each={groups()}>
        {(group) => (
          <section class="activity-day">
            <div class="activity-day-heading">
              <h2>{dateLabel(group.date)}</h2>
              <span>
                {group.rows.length} {group.rows.length === 1 ? "transaction" : "transactions"}
              </span>
            </div>
            <div class="activity-day-list">
              <For each={group.rows}>
                {(transaction) => {
                  const category = () =>
                    props.categories.find((row) => row.id === transaction.categoryId);
                  const label = () =>
                    transaction.transferId
                      ? "Transfer"
                      : transaction.isParent
                        ? "Split transaction"
                        : transaction.startingBalanceFlag
                          ? "Starting balance"
                          : (category()?.name ?? "Uncategorized");
                  return (
                    <button
                      class="activity-feed-row"
                      onClick={() => props.onSelect(transaction.id)}
                      aria-label={`Edit ${transaction.payee || label()}, ${fmt().formatCents(transaction.amount)}`}
                    >
                      <Show
                        when={
                          !transaction.transferId &&
                          !transaction.isParent &&
                          !transaction.startingBalanceFlag
                        }
                        fallback={
                          <span class="activity-special-icon">
                            <MoneyIcon name={transaction.transferId ? "move" : "accounts"} />
                          </span>
                        }
                      >
                        <CategoryBadge
                          name={category()?.name ?? "Uncategorized"}
                          icon={category()?.icon}
                        />
                      </Show>
                      <span class="activity-feed-description">
                        <strong>{transaction.payee || label()}</strong>
                        <span
                          classList={{
                            "is-uncategorized":
                              !transaction.categoryId &&
                              !transaction.isParent &&
                              !transaction.transferId &&
                              !transaction.startingBalanceFlag,
                          }}
                        >
                          {label()}
                          <Show when={!props.hideAccount}>
                            <span class="activity-account">
                              {" "}
                              · {transaction.accountName ?? "Account"}
                            </span>
                          </Show>
                        </span>
                        <Show when={transaction.notes}>
                          <small>{transaction.notes}</small>
                        </Show>
                      </span>
                      <span class="activity-feed-end">
                        <strong
                          class={privacy().blurClass()}
                          classList={{ "text-positive": transaction.amount > 0 }}
                        >
                          {transaction.amount > 0 ? "+" : ""}
                          {fmt().formatCents(transaction.amount)}
                        </strong>
                        <Show when={!transaction.cleared || transaction.reconciled}>
                          <span
                            class="activity-status"
                            classList={{ "is-pending": !transaction.cleared }}
                          >
                            <Show
                              when={transaction.reconciled}
                              fallback={transaction.cleared ? "Cleared" : "Pending"}
                            >
                              <MoneyIcon name="check" size={12} />
                              Reconciled
                            </Show>
                          </span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}
