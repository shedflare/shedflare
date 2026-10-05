import { describe, expect, test } from "vite-plus/test";
import { paymentOccurrences, type RecurringPayment } from "./recurring-view";

function payment(fields: Partial<RecurringPayment> = {}): RecurringPayment {
  return {
    id: "sch_1",
    name: "Gym",
    accountId: "acc_1",
    payeeId: null,
    categoryId: "cat_1",
    amount: -3_500,
    startDate: "2026-10-01",
    recurrenceRules: JSON.stringify({ type: "monthly" }),
    active: true,
    completed: false,
    postsTransaction: false,
    customUpcomingLength: null,
    nextDate: "2026-10-17",
    createdAt: "",
    updatedAt: "",
    ...fields,
  };
}

describe("paymentOccurrences", () => {
  test("projects every weekly occurrence left in the window", () => {
    expect(
      paymentOccurrences(
        payment({ recurrenceRules: JSON.stringify({ type: "weekly" }), nextDate: "2026-10-06" }),
        "2026-10-01",
        "2026-10-31",
      ),
    ).toEqual(["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"]);
  });

  test("keeps overdue dates that fall inside the window", () => {
    expect(
      paymentOccurrences(payment({ nextDate: "2026-09-30" }), "2026-09-01", "2026-11-30"),
    ).toEqual(["2026-09-30", "2026-10-30", "2026-11-30"]);
  });

  test("clamps month-end dates like the server", () => {
    expect(
      paymentOccurrences(payment({ nextDate: "2026-01-31" }), "2026-01-01", "2026-03-31"),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-28"]);
  });

  test("respects end rules and inactive payments", () => {
    const limited = payment({
      recurrenceRules: JSON.stringify({ type: "weekly", endMode: "after_n", endOccurrences: 2 }),
      nextDate: "2026-10-06",
    });
    expect(paymentOccurrences(limited, "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-06",
      "2026-10-13",
    ]);
    const dated = payment({
      recurrenceRules: JSON.stringify({
        type: "weekly",
        endMode: "on_date",
        endDate: "2026-10-15",
      }),
      nextDate: "2026-10-06",
    });
    expect(paymentOccurrences(dated, "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-06",
      "2026-10-13",
    ]);
    expect(paymentOccurrences(payment({ active: false }), "2026-10-01", "2026-10-31")).toEqual([]);
  });

  test("moves weekend dates the way the schedule is configured", () => {
    expect(
      paymentOccurrences(
        payment({
          recurrenceRules: JSON.stringify({ type: "monthly", skipWeekend: true }),
          nextDate: "2026-09-10",
        }),
        "2026-09-01",
        "2026-11-30",
      ),
    ).toEqual(["2026-09-10", "2026-10-12", "2026-11-12"]);
  });
});
