import * as Schema from "effect/Schema";
import type { CategoriesResponse, MonthBudget } from "../domain/schemas-client";
import { formatCalendarDate } from "../domain/types";

export type BudgetCategory = MonthBudget["categories"][number];
export type CategoryDefinition = CategoriesResponse["categories"][number];

export const GoalSchema = Schema.Struct({
  type: Schema.Literals(["monthly", "byDate", "refill", "periodic", "percentage"]),
  amount: Schema.optional(Schema.Number),
  targetDate: Schema.optional(Schema.String),
  frequency: Schema.optional(Schema.String),
  percentage: Schema.optional(Schema.Number),
});

export function readGoal(definition: string | null | undefined) {
  if (!definition) return null;
  try {
    return Schema.decodeUnknownSync(GoalSchema)(JSON.parse(definition));
  } catch {
    return null;
  }
}

export function currentMonthKey(): string {
  return formatCalendarDate(new Date()).slice(0, 7);
}

export function shiftMonth(month: string, offset: number): string {
  const [year, number] = month.split("-").map(Number);
  return formatCalendarDate(new Date(year, number - 1 + offset, 1)).slice(0, 7);
}

export function expenseCategories(
  rows: readonly BudgetCategory[],
  definitions: readonly CategoryDefinition[],
) {
  const expenseIds = new Set(
    definitions
      .filter((category) => !category.isIncome && !category.hidden)
      .map((category) => category.id),
  );
  return rows.filter((category) => expenseIds.has(category.categoryId));
}

export function availableRatio(category: BudgetCategory): number {
  const capacity = category.leftover - category.spent;
  return capacity > 0 ? Math.min(1, Math.max(0, category.leftover / capacity)) : 0;
}

export function categoryTone(name: string): string {
  const tones = ["sage", "peach", "blue", "lilac", "sand"];
  let sum = 0;
  for (let index = 0; index < name.length; index++) sum += name.charCodeAt(index);
  return tones[sum % tones.length];
}

export function monthlyTarget(definition: string | null | undefined): number | null {
  const goal = readGoal(definition);
  return goal?.type === "monthly" && goal.amount && goal.amount > 0 ? goal.amount : null;
}
