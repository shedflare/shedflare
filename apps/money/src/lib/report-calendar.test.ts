import { describe, expect, test } from "vite-plus/test";
import {
  calendarEntries,
  calendarWeeks,
  elapsedDays,
  spendingLevel,
  weekStartForLocale,
  weekdayLabels,
} from "./report-calendar";

describe("report calendar", () => {
  test("pads November 2026 (starts Sunday) to whole weeks for both week starts", () => {
    const days = [{ date: "2026-11-07", income: 0, expense: 1200 }];
    const sunday = calendarWeeks("2026-11", days, 0);
    expect(sunday).toHaveLength(5);
    expect(sunday[0][0]).toMatchObject({ kind: "day", date: "2026-11-01" });
    expect(sunday[0][6]).toMatchObject({ date: "2026-11-07", expense: 1200, income: 0 });
    expect(sunday[4][1]).toMatchObject({ date: "2026-11-30" });
    expect(sunday[4][2].kind).toBe("blank");

    const monday = calendarWeeks("2026-11", days, 1);
    expect(monday).toHaveLength(6);
    expect(monday[0].slice(0, 6).every((cell) => cell.kind === "blank")).toBe(true);
    expect(monday[0][6]).toMatchObject({ date: "2026-11-01" });
    expect(monday.flat().filter((cell) => cell.kind === "day")).toHaveLength(30);
  });

  test("uses leap-year month length", () => {
    const cells = calendarWeeks("2024-02", [], 1).flat();
    expect(cells.filter((cell) => cell.kind === "day").at(-1)).toMatchObject({
      date: "2024-02-29",
    });
  });

  test("weekday labels follow the week start", () => {
    expect(weekStartForLocale("en-US")).toBe(0);
    expect(weekStartForLocale("id-ID")).toBe(1);
    expect(weekdayLabels("en-US", 0)[0]).toBe("Sun");
    expect(weekdayLabels("en-US", 1)[0]).toBe("Mon");
  });

  test("spending levels scale to the busiest day and ignore refunds", () => {
    expect(spendingLevel(0, 1000)).toBe(0);
    expect(spendingLevel(-50, 1000)).toBe(0);
    expect(spendingLevel(1, 1000)).toBe(1);
    expect(spendingLevel(500, 1000)).toBe(2);
    expect(spendingLevel(1000, 1000)).toBe(4);
  });

  test("elapsed days for past, current, and future months", () => {
    expect(elapsedDays("2026-10", "2026-11-07")).toBe(31);
    expect(elapsedDays("2026-11", "2026-11-07")).toBe(7);
    expect(elapsedDays("2026-12", "2026-11-07")).toBe(0);
  });
});

describe("calendarEntries", () => {
  const row = (
    id: string,
    fields: Partial<Parameters<typeof calendarEntries>[0][number]> = {},
  ) => ({
    id,
    date: "2026-10-03",
    amount: -100,
    payee: null,
    categoryName: null,
    isChild: false,
    parentId: null,
    startingBalanceFlag: false,
    ...fields,
  });
  test("lists scheduled payments first, then the day's biggest transactions", () => {
    const days = calendarEntries(
      [
        row("small", { payee: "Coffee", amount: -50 }),
        row("big", { categoryName: "Rent", amount: -9000 }),
        row("pay", { payee: "Salary", amount: 20000 }),
        row("split-child", { amount: -40, isChild: true, parentId: "big" }),
        row("opening", { amount: 5000, startingBalanceFlag: true }),
      ],
      new Map([
        [
          "2026-10-03",
          [{ date: "2026-09-30", payment: { id: "sch", name: "Gym", amount: -3500 } }],
        ],
      ]),
      "2026-10-12",
    );
    expect(
      days.get("2026-10-03")?.map((entry) => [entry.label, entry.kind, entry.overdue]),
    ).toEqual([
      ["Gym", "scheduled", true],
      ["Salary", "transaction", undefined],
      ["Rent", "transaction", undefined],
      ["Coffee", "transaction", undefined],
    ]);
  });
});
