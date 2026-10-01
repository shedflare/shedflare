import { describe, expect, test } from "vite-plus/test";
import {
  availableRatio,
  expenseCategories,
  monthlyTarget,
  shiftMonth,
  type BudgetCategory,
} from "./budget-view";
import * as Schema from "effect/Schema";
import { CategoryIdSchema } from "../domain/types";

function category(leftover: number, spent: number, budgeted: number): BudgetCategory {
  return {
    categoryId: Schema.decodeUnknownSync(CategoryIdSchema)("cat_groceries"),
    categoryName: "Groceries",
    groupId: null,
    groupName: null,
    budgeted,
    spent,
    leftover,
    leftoverPos: Math.max(0, leftover),
    carryover: false,
  };
}

describe("everyday budget presentation", () => {
  test("the available meter includes carried money rather than using this month’s assignment alone", () => {
    expect(availableRatio(category(7_500, -2_500, 5_000))).toBe(0.75);
    expect(availableRatio(category(-500, -3_000, 2_500))).toBe(0);
    expect(availableRatio(category(0, 0, 0))).toBe(0);
  });
  test("income and hidden categories do not become spendable envelopes", () => {
    const rows = [category(7_500, -2_500, 5_000)];
    const base = {
      id: rows[0].categoryId,
      name: "Groceries",
      groupId: null,
      sortOrder: 0,
      goalDef: null,
      createdAt: "",
      updatedAt: "",
      hidden: false,
      isIncome: false,
    };
    expect(expenseCategories(rows, [base])).toHaveLength(1);
    expect(expenseCategories(rows, [{ ...base, isIncome: true }])).toHaveLength(0);
    expect(expenseCategories(rows, [{ ...base, hidden: true }])).toHaveLength(0);
  });
  test("only monthly targets are compared to a monthly assignment", () => {
    expect(monthlyTarget('{"type":"monthly","amount":25000}')).toBe(25_000);
    expect(monthlyTarget('{"type":"byDate","amount":25000}')).toBeNull();
    expect(monthlyTarget("invalid")).toBeNull();
  });
  test("month navigation crosses years without skipping a month", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});
