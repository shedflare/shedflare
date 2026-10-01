import { monthlyTarget, type BudgetCategory, type CategoryDefinition } from "./budget-view";

export type PlanSource = "targets" | "previous";

export function previousPerformance(category: BudgetCategory) {
  const spent = Math.max(0, -category.spent);
  const difference = category.budgeted - spent;
  const status =
    category.budgeted === 0 && spent === 0
      ? "empty"
      : difference < 0
        ? "over"
        : difference > 0
          ? "under"
          : "even";
  return { budgeted: category.budgeted, spent, difference, status };
}

export function monthlyPlan(
  categories: readonly BudgetCategory[],
  definitions: readonly CategoryDefinition[],
  previous: readonly BudgetCategory[],
  source: PlanSource,
) {
  return categories.flatMap((category) => {
    const definition = definitions.find((row) => row.id === category.categoryId);
    if (!definition || definition.hidden || definition.isIncome) return [];
    const last = previous.find((row) => row.categoryId === category.categoryId);
    const target = source === "targets" ? monthlyTarget(definition.goalDef) : (last?.budgeted ?? 0);
    if (target == null || !Number.isSafeInteger(target)) return [];
    if (source === "targets" && target <= category.budgeted) return [];
    const amount = target - category.budgeted;
    if (!Number.isSafeInteger(amount)) return [];
    return [{ category, icon: definition.icon, target, amount, previous: last }];
  });
}
