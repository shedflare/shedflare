import { describe, expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CategoryIdSchema } from "../domain/types";
import type { BudgetCategory, CategoryDefinition } from "./budget-view";
import { monthlyPlan, previousPerformance } from "./monthly-plan";

const category: BudgetCategory = {
  categoryId: Schema.decodeUnknownSync(CategoryIdSchema)("cat_holiday"),
  categoryName: "Holiday",
  groupId: null,
  groupName: null,
  budgeted: 350_000_000,
  spent: -100_000_000,
  leftover: 300_000_000,
  leftoverPos: 300_000_000,
  carryover: false,
};
const definition: CategoryDefinition = {
  id: category.categoryId,
  name: "Holiday",
  icon: "plane",
  isIncome: false,
  hidden: false,
  groupId: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  goalDef: '{"type":"monthly","amount":400000000}',
};

describe("monthly plan preview", () => {
  test("tops up the assignment toward a monthly target, with spending and carried balances left alone", () => {
    expect(monthlyPlan([category], [definition], [], "targets")).toMatchObject([
      { amount: 50_000_000, target: 400_000_000, icon: "plane" },
    ]);
    expect(
      monthlyPlan([{ ...category, budgeted: 450_000_000 }], [definition], [], "targets"),
    ).toEqual([]);
  });
  test("copy starts with full last-month amounts, including reductions, unchanged amounts, and zero for a new category", () => {
    for (const target of [375_000_000, 300_000_000, category.budgeted, 0]) {
      expect(
        monthlyPlan([category], [definition], [{ ...category, budgeted: target }], "previous"),
      ).toMatchObject([
        { target, amount: target - category.budgeted, previous: { budgeted: target } },
      ]);
    }
    expect(monthlyPlan([category], [definition], [], "previous")).toMatchObject([
      { target: 0, amount: -category.budgeted },
    ]);
    expect(
      monthlyPlan([category], [{ ...definition, hidden: true }], [category], "previous"),
    ).toEqual([]);
    expect(
      monthlyPlan([category], [{ ...definition, isIncome: true }], [category], "previous"),
    ).toEqual([]);
  });
  test("last-month performance compares spending with the assigned plan, independent of carried balances", () => {
    expect(
      previousPerformance({
        ...category,
        budgeted: 50_000_000,
        spent: -62_500_000,
        leftover: 500_000_000,
      }),
    ).toMatchObject({ status: "over", difference: -12_500_000, spent: 62_500_000 });
    expect(previousPerformance(category)).toMatchObject({
      status: "under",
      difference: 250_000_000,
    });
    expect(previousPerformance({ ...category, budgeted: 100_000_000 })).toMatchObject({
      status: "even",
      difference: 0,
    });
    expect(previousPerformance({ ...category, budgeted: 0, spent: 0 })).toMatchObject({
      status: "empty",
    });
    expect(previousPerformance({ ...category, spent: 10_000 })).toMatchObject({
      status: "under",
      spent: 0,
      difference: category.budgeted,
    });
  });
  test("excludes unsupported or invalid goals and unavailable categories", () => {
    for (const change of [
      { hidden: true },
      { isIncome: true },
      { goalDef: '{"type":"byDate","amount":400000000}' },
      { goalDef: '{"type":"monthly","amount":400000000.5}' },
      { goalDef: "broken" },
    ])
      expect(monthlyPlan([category], [{ ...definition, ...change }], [], "targets")).toEqual([]);
  });
});
