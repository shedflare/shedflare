import { monthBoundaries } from "../domain/types";
import { paymentOccurrences, type RecurringPayment } from "./recurring-view";

export interface BalancePoint {
  /** Day of the month, 1-based */
  day: number;
  date: string;
  /** End-of-day available balance in cents */
  value: number;
  /** Scheduled payments landing on this day, for the tooltip */
  scheduled: readonly { name: string; amount: number }[];
}

export interface CategoryBalanceSeries {
  days: number;
  actual: BalancePoint[];
  /** Starts at the last actual point so the dashed line continues the solid one */
  projected: BalancePoint[];
}

/**
 * Daily available balance for one category across a month. Recorded activity draws the actual
 * line up to today; active scheduled payments in the category project the rest of the month,
 * with overdue ones landing today.
 */
export function categoryBalanceSeries(input: {
  month: string;
  categoryId: string;
  /** Available at the end of the month so far, including all recorded activity */
  leftover: number;
  /** Recorded activity this month (negative is spending) */
  spent: number;
  transactions: readonly { date: string; amount: number }[];
  payments: readonly RecurringPayment[];
  today: string;
}): CategoryBalanceSeries {
  const { start, end } = monthBoundaries(input.month);
  const days = Number(end.slice(8, 10));
  const dateOf = (day: number) => `${input.month}-${String(day).padStart(2, "0")}`;
  const lastActualDay =
    input.today < start ? 0 : input.today > end ? days : Number(input.today.slice(8, 10));

  const byDay = new Map<number, number>();
  for (const transaction of input.transactions) {
    if (transaction.date < start || transaction.date > end) continue;
    const day = Number(transaction.date.slice(8, 10));
    byDay.set(day, (byDay.get(day) ?? 0) + transaction.amount);
  }

  let balance = input.leftover - input.spent;
  const actual: BalancePoint[] = [];
  for (let day = 1; day <= lastActualDay; day++) {
    balance += byDay.get(day) ?? 0;
    actual.push({ day, date: dateOf(day), value: balance, scheduled: [] });
  }
  // Activity recorded after today (future-dated) still counts toward what's available now.
  if (actual.length) actual[actual.length - 1].value = input.leftover;
  balance = input.leftover;

  if (input.today > end) return { days, actual, projected: [] };
  const firstDay = Math.max(1, lastActualDay);
  const due = new Map<number, { name: string; amount: number }[]>();
  for (const payment of input.payments) {
    if (payment.categoryId !== input.categoryId || payment.amount === null) continue;
    const from = lastActualDay ? "0000-01-01" : start;
    for (const date of paymentOccurrences(payment, from, end)) {
      const day = date < start ? firstDay : Math.max(firstDay, Number(date.slice(8, 10)));
      const list = due.get(day) ?? [];
      list.push({ name: payment.name ?? "Scheduled", amount: payment.amount });
      due.set(day, list);
    }
  }
  if (!due.size) return { days, actual, projected: [] };

  const projected: BalancePoint[] = [];
  if (lastActualDay) projected.push({ ...actual[actual.length - 1] });
  else projected.push({ day: 1, date: dateOf(1), value: balance, scheduled: [] });
  for (let day = firstDay; day <= days; day++) {
    const payments = due.get(day) ?? [];
    if (!payments.length && day !== days) continue;
    balance += payments.reduce((sum, payment) => sum + payment.amount, 0);
    projected.push({ day, date: dateOf(day), value: balance, scheduled: payments });
  }
  return { days, actual, projected };
}
