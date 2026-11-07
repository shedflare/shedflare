import { describe, expect, test } from "vite-plus/test";
import {
  paymentOccurrences,
  recordDate,
  scheduledByDay,
  type RecurringPayment,
} from "./recurring-view";

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

describe("scheduledByDay", () => {
  test("lists each occurrence on its day and marks only the next one recordable", () => {
    const weekly = payment({
      id: "sch_weekly",
      name: "Lunch",
      recurrenceRules: JSON.stringify({ type: "weekly" }),
      nextDate: "2026-10-06",
    });
    const paused = payment({ id: "sch_paused", active: false, nextDate: "2026-10-06" });
    const days = scheduledByDay([weekly, payment(), paused], "2026-10-01", "2026-10-31");
    expect([...days.keys()].toSorted()).toEqual([
      "2026-10-06",
      "2026-10-13",
      "2026-10-17",
      "2026-10-20",
      "2026-10-27",
    ]);
    expect(days.get("2026-10-06")?.map((row) => [row.payment.id, row.isNext])).toEqual([
      ["sch_weekly", true],
    ]);
    expect(days.get("2026-10-13")?.[0].isNext).toBe(false);
    expect(days.get("2026-10-17")?.[0]).toMatchObject({ isNext: true, payment: { id: "sch_1" } });
  });

  test("shows payments overdue from earlier months on today, keeping their due date", () => {
    const overdue = payment({ id: "sch_late", nextDate: "2026-09-30" });
    const days = scheduledByDay([overdue], "2026-10-01", "2026-10-31", "2026-10-12");
    expect(days.get("2026-10-12")).toEqual([
      { payment: overdue, date: "2026-09-30", isNext: true },
    ]);
    expect(days.get("2026-10-30")?.[0]).toMatchObject({ date: "2026-10-30", isNext: false });
    // Other months, and paused payments, are left as they are.
    expect(scheduledByDay([overdue], "2026-11-01", "2026-11-30", "2026-10-12").size).toBe(1);
    expect(
      scheduledByDay([{ ...overdue, active: false }], "2026-10-01", "2026-10-31", "2026-10-12")
        .size,
    ).toBe(0);
  });

  test("records overdue payments on their day and early payments today", () => {
    expect(recordDate("2026-11-03", "2026-11-07")).toBe("2026-11-03");
    expect(recordDate("2026-11-07", "2026-11-07")).toBe("2026-11-07");
    expect(recordDate("2026-11-20", "2026-11-07")).toBe("2026-11-07");
  });
});
