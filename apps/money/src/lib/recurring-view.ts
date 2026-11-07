import * as Schema from "effect/Schema";
import type { SchedulesResponse } from "../domain/schemas-client";

export type RecurringPayment = SchedulesResponse["schedules"][number];
const RecurrenceSchema = Schema.Struct({
  type: Schema.String,
  skipWeekend: Schema.optional(Schema.Boolean),
  weekendSolveMode: Schema.optional(Schema.Literals(["before", "after"])),
  endMode: Schema.optional(Schema.String),
  endOccurrences: Schema.optional(Schema.Number),
  endDate: Schema.optional(Schema.String),
});
export function recurrenceConfig(rules: string): Schema.Schema.Type<typeof RecurrenceSchema> {
  try {
    const value = Schema.decodeUnknownSync(Schema.Union([RecurrenceSchema, Schema.String]))(
      JSON.parse(rules),
    );
    return value instanceof Object ? value : { type: value };
  } catch {
    return { type: rules || "monthly" };
  }
}
export const FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Every three months" },
  { value: "yearly", label: "Yearly" },
];
export function recurrenceLabel(rules: string): string {
  const type = recurrenceConfig(rules).type;
  return FREQUENCIES.find((row) => row.value === type)?.label ?? type;
}
export function paymentDate(payment: RecurringPayment): string | null {
  return payment.nextDate ?? payment.startDate;
}
export function orderedPayments(payments: readonly RecurringPayment[]): RecurringPayment[] {
  return [...payments].sort(
    (a, b) =>
      (paymentDate(a) ?? "9999").localeCompare(paymentDate(b) ?? "9999") ||
      (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

function addUtcMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

const STEP_DAYS = new Map([
  ["daily", 1],
  ["weekly", 7],
  ["biweekly", 14],
]);

/** Mirrors the server's schedule advance so projections match what recording will produce. */
function nextOccurrence(date: string, config: ReturnType<typeof recurrenceConfig>): string {
  const current = new Date(`${date}T00:00:00.000Z`);
  const days = STEP_DAYS.get(config.type);
  const next =
    days !== undefined
      ? new Date(current.setUTCDate(current.getUTCDate() + days))
      : addUtcMonths(current, config.type === "quarterly" ? 3 : config.type === "yearly" ? 12 : 1);
  if (config.skipWeekend) {
    const weekday = next.getUTCDay();
    const before = config.weekendSolveMode === "before";
    if (weekday === 6) next.setUTCDate(next.getUTCDate() + (before ? -1 : 2));
    if (weekday === 0) next.setUTCDate(next.getUTCDate() + (before ? -2 : 1));
  }
  return next.toISOString().slice(0, 10);
}

/** Dates an active payment is still due within [from, to], starting at its next date. */
export function paymentOccurrences(payment: RecurringPayment, from: string, to: string): string[] {
  const first = paymentDate(payment);
  if (!payment.active || payment.completed || !first) return [];
  const config = recurrenceConfig(payment.recurrenceRules);
  const limited = config.endMode === "after_n" || config.endMode === "after_n_occurrences";
  let remaining = limited ? Math.max(1, config.endOccurrences ?? 1) : Number.POSITIVE_INFINITY;
  const endDate = config.endMode === "on_date" ? config.endDate : undefined;
  const dates: string[] = [];
  let date = first;
  for (let guard = 0; guard < 400 && date <= to && remaining > 0; guard++) {
    if (endDate && date > endDate) break;
    if (date >= from) dates.push(date);
    remaining--;
    date = nextOccurrence(date, config);
  }
  return dates;
}

export type ScheduledOccurrence = {
  payment: RecurringPayment;
  date: string;
  /** Only the next occurrence can be recorded; later ones follow once it is. */
  isNext: boolean;
};

/**
 * Upcoming occurrences of active payments within [start, end], keyed by the day they are shown.
 * When `today` is in range, payments still due from before `start` are shown on today, keeping
 * their original due date.
 */
export function scheduledByDay(
  payments: readonly RecurringPayment[],
  start: string,
  end: string,
  today?: string,
): Map<string, ScheduledOccurrence[]> {
  const days = new Map<string, ScheduledOccurrence[]>();
  const carryOver = today !== undefined && today >= start && today <= end;
  for (const payment of orderedPayments(payments)) {
    const next = paymentDate(payment);
    if (carryOver && next && next < start && paymentOccurrences(payment, next, next).length) {
      const rows = days.get(today) ?? [];
      rows.push({ payment, date: next, isNext: true });
      days.set(today, rows);
    }
    for (const date of paymentOccurrences(payment, start, end)) {
      const rows = days.get(date) ?? [];
      rows.push({ payment, date, isNext: date === next });
      days.set(date, rows);
    }
  }
  return days;
}

/** A recorded payment is dated on its scheduled day, or today when paid ahead of time. */
export function recordDate(occurrence: string, today: string): string {
  return occurrence < today ? occurrence : today;
}
