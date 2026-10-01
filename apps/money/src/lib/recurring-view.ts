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
