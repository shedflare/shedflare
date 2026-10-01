import { expect, test } from "vite-plus/test";
import { accountLedger } from "./account-view";
test("same-day transactions keep chronological balances and the latest equals the live balance", () => {
  const rows = accountLedger(
    [
      { id: "new", date: "2026-10-01", createdAt: "2026-10-01T12:00:00Z", amount: -125_000_000 },
      { id: "old", date: "2026-10-01", createdAt: "2026-10-01T08:00:00Z", amount: 200_000_000 },
      { id: "prior", date: "2026-09-30", createdAt: "2026-09-30T12:00:00Z", amount: -50_000_000 },
    ],
    1_000_000_000,
  );
  expect(rows.map((row) => [row.id, row.balance])).toEqual([
    ["new", 1_025_000_000],
    ["old", 1_150_000_000],
    ["prior", 950_000_000],
  ]);
});
test("split children do not change account balances and equal timestamps preserve feed order", () => {
  const rows = accountLedger(
    [
      { id: "child", date: "2026-10-01", amount: -40_000_000, isChild: true },
      { id: "parent", date: "2026-10-01", amount: -100_000_000, isChild: false },
    ],
    500_000_000,
  );
  expect(rows.map((row) => [row.id, row.balance])).toEqual([
    ["child", 400_000_000],
    ["parent", 400_000_000],
  ]);
});
