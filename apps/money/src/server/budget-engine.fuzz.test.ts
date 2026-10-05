import { describe, expect, test } from "vite-plus/test";
import * as schema from "../db/schema";
import { createFuzzRandom } from "../test/fuzz";
import { createMoneyTestEnv, dbFor } from "../test/helpers";
import { computeMonthBudget } from "./budget-engine";

const SEED = 0xbad6e7;
const CATEGORY_COUNT = 72;

interface ExpectedCategory {
  budgeted: number;
  spent: number;
  leftover: number;
  leftoverPos: number;
  carryover: boolean;
}

describe("budget engine fuzzing", () => {
  test(`preserves envelope invariants for ${CATEGORY_COUNT} randomized categories (seed ${SEED})`, async () => {
    const random = createFuzzRandom(SEED);
    const db = dbFor(createMoneyTestEnv());
    const now = "2026-04-15T00:00:00.000Z";
    const buffered = random.int(0, 250_000);

    await db
      .insert(schema.categoryGroups)
      .values([
        {
          id: "cgrp_income",
          name: "Income",
          isIncome: true,
          sortOrder: 0,
          hidden: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "cgrp_expense",
          name: "Expenses",
          isIncome: false,
          sortOrder: 1,
          hidden: false,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    await db
      .insert(schema.accounts)
      .values({
        id: "acct_fuzz",
        name: "Fuzz Checking",
        offbudget: false,
        closed: false,
        sortOrder: 0,
        balanceCurrent: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const categories: Array<typeof schema.categories.$inferInsert> = [];
    const budgets: Array<typeof schema.budgets.$inferInsert> = [];
    const transactions: Array<typeof schema.transactions.$inferInsert> = [];
    const expectedByCategory = new Map<string, ExpectedCategory>();
    let expectedIncome = 0;
    let expectedBudgeted = 0;
    let previousIncome = 0;
    let previousBudgeted = 0;
    let overspentLastMonth = 0;

    for (let index = 0; index < CATEGORY_COUNT; index++) {
      const categoryId = `cat_fuzz_${String(index).padStart(3, "0")}`;
      const isIncome = index % 9 === 0;
      const previousBudget = isIncome ? 0 : random.int(0, 200_000);
      const currentBudget = isIncome ? 0 : random.int(0, 200_000);
      const previousSpent = isIncome ? random.int(0, 400_000) : -random.int(0, 250_000);
      const currentSpent = isIncome ? random.int(0, 400_000) : -random.int(0, 250_000);
      const carryover = random.bool();
      // Expense balances roll forward; income only funds To assign.
      const previousLeftover = isIncome ? 0 : previousBudget + previousSpent;
      const carryoverAmount = carryover ? previousLeftover : Math.max(previousLeftover, 0);
      const leftover = currentBudget + currentSpent + carryoverAmount;
      if (!carryover) overspentLastMonth += Math.max(-previousLeftover, 0);

      categories.push({
        id: categoryId,
        name: `Fuzz category ${index}`,
        isIncome,
        groupId: isIncome ? "cgrp_income" : "cgrp_expense",
        sortOrder: index,
        hidden: false,
        goalDef: null,
        createdAt: now,
        updatedAt: now,
      });
      budgets.push(
        {
          id: `202603-${categoryId}`,
          month: 202603,
          categoryId,
          amount: previousBudget,
          carryover: random.bool(),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `202604-${categoryId}`,
          month: 202604,
          categoryId,
          amount: currentBudget,
          carryover,
          createdAt: now,
          updatedAt: now,
        },
      );
      transactions.push(
        {
          id: `txn_prev_${index}`,
          accountId: "acct_fuzz",
          categoryId,
          amount: previousSpent,
          date: index % 2 === 0 ? "2026-03-01" : "2026-03-31",
          cleared: true,
          reconciled: false,
          isParent: false,
          isChild: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `txn_current_${index}`,
          accountId: "acct_fuzz",
          categoryId,
          amount: currentSpent,
          date: index % 2 === 0 ? "2026-04-01" : "2026-04-30",
          cleared: true,
          reconciled: false,
          isParent: false,
          isChild: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `txn_child_noise_${index}`,
          accountId: "acct_fuzz",
          categoryId,
          amount: random.int(-500_000, 500_000),
          date: "2026-04-15",
          cleared: true,
          reconciled: false,
          isParent: false,
          isChild: true,
          parentId: `txn_current_${index}`,
          createdAt: now,
          updatedAt: now,
        },
      );

      expectedByCategory.set(categoryId, {
        budgeted: currentBudget,
        spent: currentSpent,
        leftover,
        leftoverPos: Math.max(leftover, 0),
        carryover,
      });
      if (isIncome) {
        expectedIncome += currentSpent;
        previousIncome += previousSpent;
      }
      expectedBudgeted += currentBudget;
      previousBudgeted += previousBudget;
    }

    await db.insert(schema.categories).values(categories).run();
    await db.insert(schema.budgets).values(budgets).run();
    await db.insert(schema.transactions).values(transactions).run();
    await db
      .insert(schema.budgetMonths)
      .values({
        id: "2026-04",
        buffered,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const result = await computeMonthBudget(db, 202604);
    expect(result).not.toBeNull();
    expect(result!.categories).toHaveLength(CATEGORY_COUNT);
    const fromLastMonth = previousIncome - previousBudgeted;
    expect(result!.fromLastMonth).toBe(fromLastMonth);
    expect(result!.overspentLastMonth).toBe(overspentLastMonth);
    expect(result!.toBudget).toBe(
      fromLastMonth + expectedIncome - overspentLastMonth - expectedBudgeted - buffered,
    );
    expect(result!.buffered).toBe(buffered);

    for (const category of result!.categories) {
      expect(category, `category ${category.categoryId}`).toEqual(
        expect.objectContaining(expectedByCategory.get(category.categoryId)),
      );
    }

    expect(result!.categoryLeftovers).toEqual(
      result!.categories.map(({ categoryId, leftover, leftoverPos, budgeted, spent }) => ({
        categoryId,
        leftover,
        leftoverPos,
        budgeted,
        spent,
      })),
    );
  });
});
