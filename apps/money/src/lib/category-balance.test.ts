import { describe, expect, test } from "vite-plus/test";
import { categoryBalanceSeries } from "./category-balance";
import type { RecurringPayment } from "./recurring-view";

function payment(fields: Partial<RecurringPayment> = {}): RecurringPayment {
  return {
    id: "sch_1",
    name: "Gym",
    accountId: "acc_1",
    payeeId: null,
    categoryId: "cat_1",
    amount: -3_000,
    startDate: "2026-09-01",
    recurrenceRules: JSON.stringify({ type: "monthly" }),
    active: true,
    completed: false,
    postsTransaction: false,
    customUpcomingLength: null,
    nextDate: "2026-10-20",
    createdAt: "",
    updatedAt: "",
    ...fields,
  };
}

const base = {
  month: "2026-10",
  categoryId: "cat_1",
  leftover: 7_000,
  spent: -3_000,
  transactions: [
    { date: "2026-10-02", amount: -1_000 },
    { date: "2026-10-05", amount: -2_000 },
  ],
  payments: [],
  today: "2026-10-09",
};

describe("categoryBalanceSeries", () => {
  test("walks the balance down from the month's start through today", () => {
    const series = categoryBalanceSeries(base);
    expect(series.days).toBe(31);
    expect(series.actual.map((point) => point.value)).toEqual([
      10_000, 9_000, 9_000, 9_000, 7_000, 7_000, 7_000, 7_000, 7_000,
    ]);
    expect(series.projected).toEqual([]);
  });

  test("projects scheduled payments to month end, overdue ones landing today", () => {
    const series = categoryBalanceSeries({
      ...base,
      payments: [
        payment(),
        payment({ id: "sch_2", name: "Late", amount: -500, nextDate: "2026-10-03" }),
        payment({ id: "sch_3", categoryId: "cat_2" }),
      ],
    });
    expect(series.projected.map((point) => [point.day, point.value])).toEqual([
      [9, 7_000],
      [9, 6_500],
      [20, 3_500],
      [31, 3_500],
    ]);
    expect(series.projected[2].scheduled).toEqual([{ name: "Gym", amount: -3_000 }]);
  });

  test("past months have no projection and future months only project", () => {
    expect(
      categoryBalanceSeries({ ...base, payments: [payment()], today: "2026-11-02" }).projected,
    ).toEqual([]);
    const future = categoryBalanceSeries({
      ...base,
      spent: 0,
      transactions: [],
      payments: [payment()],
      today: "2026-09-15",
    });
    expect(future.actual).toEqual([]);
    expect(future.projected.map((point) => [point.day, point.value])).toEqual([
      [1, 7_000],
      [20, 4_000],
      [31, 4_000],
    ]);
  });
});
