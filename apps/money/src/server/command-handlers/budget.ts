import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../d1-access";
import * as s from "../../db/schema";
import { computeMonthBudget } from "../budget-engine";
import { toMonthInt, nowIso, budgetId } from "../../domain/types";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";

type BudgetCommand =
  | "set_budget_amount"
  | "allocate_budget"
  | "set_budget_plan"
  | "set_budget_carryover"
  | "set_buffer"
  | "copy_previous_month"
  | "set_3month_avg"
  | "set_nmonth_avg"
  | "set_zero"
  | "apply_goal_templates"
  | "cover_overspending"
  | "transfer_budget"
  | "hold_for_next_month";

type BudgetInvocation = Extract<CommandInvocation, { commandType: BudgetCommand }>;

export async function handleBudgetCommands(
  command: BudgetInvocation,
  db: Db,
): Promise<CommandResult> {
  switch (command.commandType) {
    case "set_budget_plan": {
      const { month: key, assignments } = command.payload;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || assignments.length === 0) {
        return { ok: false, error: "Choose a valid month and at least one category" };
      }
      const ids = assignments.map((row) => row.categoryId);
      if (
        new Set(ids).size !== ids.length ||
        assignments.some((row) => !Number.isSafeInteger(row.amount))
      ) {
        return { ok: false, error: "Use distinct categories and whole amounts" };
      }
      const categories = await db
        .select()
        .from(s.categories)
        .where(inArray(s.categories.id, ids))
        .all();
      if (
        categories.length !== ids.length ||
        categories.some((row) => row.hidden || row.isIncome)
      ) {
        return { ok: false, error: "Choose visible expense categories" };
      }
      const month = toMonthInt(key);
      const before = await computeMonthBudget(db, month);
      const amounts = new Map(assignments.map((row) => [row.categoryId, row.amount]));
      if (
        !before ||
        !Number.isSafeInteger(before.toBudget) ||
        !Number.isSafeInteger(
          before.toBudget +
            before.categories.reduce(
              (sum, row) =>
                sum +
                (amounts.has(row.categoryId)
                  ? row.budgeted - (amounts.get(row.categoryId) ?? 0)
                  : 0),
              0,
            ),
        )
      ) {
        return { ok: false, error: "The planned amount is too large" };
      }
      const now = nowIso();
      const [first, ...rest] = assignments.map((row) =>
        db
          .insert(s.budgets)
          .values({
            id: budgetId(month, row.categoryId),
            month,
            categoryId: row.categoryId,
            amount: row.amount,
            carryover: false,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: s.budgets.id,
            set: { amount: row.amount, updatedAt: now },
          }),
      );
      if (first) await db.batch([first, ...rest]);
      return { ok: true, data: { month, budget: await computeMonthBudget(db, month) } };
    }

    case "allocate_budget": {
      const { month: key, allocations } = command.payload;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || allocations.length === 0) {
        return { ok: false, error: "Choose a valid month and at least one category" };
      }
      const ids = allocations.map((row) => row.categoryId);
      if (
        new Set(ids).size !== ids.length ||
        allocations.some((row) => !Number.isSafeInteger(row.amount) || row.amount === 0)
      ) {
        return { ok: false, error: "Use distinct categories and whole amounts" };
      }
      const categories = await db
        .select()
        .from(s.categories)
        .where(inArray(s.categories.id, ids))
        .all();
      if (
        categories.length !== ids.length ||
        categories.some((category) => category.hidden || category.isIncome)
      ) {
        return { ok: false, error: "Choose visible expense categories" };
      }
      const month = toMonthInt(key);
      const before = await computeMonthBudget(db, month);
      const total = allocations.reduce((sum, row) => sum + row.amount, 0);
      if (
        !before ||
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(before.toBudget - total) ||
        allocations.some(
          (row) =>
            !Number.isSafeInteger(
              (before.categories.find((category) => category.categoryId === row.categoryId)
                ?.budgeted ?? 0) + row.amount,
            ),
        )
      ) {
        return { ok: false, error: "The planned amount is too large" };
      }
      const now = nowIso();
      // Add deltas so applying/undoing a plan preserves later individual assignments.
      // D1 batch is transactional: a failed category leaves the whole plan untouched.
      const [first, ...rest] = allocations.map((row) =>
        db
          .insert(s.budgets)
          .values({
            id: budgetId(month, row.categoryId),
            month,
            categoryId: row.categoryId,
            amount: row.amount,
            carryover: false,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: s.budgets.id,
            set: { amount: sql`${s.budgets.amount} + ${row.amount}`, updatedAt: now },
          }),
      );
      if (first) await db.batch([first, ...rest]);
      return { ok: true, data: { month, budget: await computeMonthBudget(db, month) } };
    }

    case "set_budget_amount": {
      const p = command.payload;
      const { month, categoryId, amount } = p;
      const id = budgetId(month, categoryId);
      const now = nowIso();
      await db
        .insert(s.budgets)
        .values({ id, month, categoryId, amount, carryover: false, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: s.budgets.id,
          set: { amount, updatedAt: now },
        })
        .run();
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "set_budget_carryover": {
      const p = command.payload;
      const { month, categoryId, carryover } = p;
      await db
        .update(s.budgets)
        .set({ carryover, updatedAt: nowIso() })
        .where(sql`${s.budgets.month} = ${month} AND ${s.budgets.categoryId} = ${categoryId}`)
        .run();
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "set_buffer": {
      const p = command.payload;
      const month = toMonthInt(p.month);
      const now = nowIso();
      await db
        .insert(s.budgetMonths)
        .values({ id: p.month, buffered: p.amount, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: s.budgetMonths.id,
          set: { buffered: p.amount, updatedAt: now },
        })
        .run();
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "copy_previous_month": {
      const p = command.payload;
      const monthKey = p.month;
      const month = toMonthInt(monthKey);
      const [y, m] = monthKey.split("-").map(Number);
      const prev = new Date(y, m - 2, 1);
      const prevMk = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
      const prevMonth = toMonthInt(prevMk);

      const prevBudgets = await db
        .select()
        .from(s.budgets)
        .where(eq(s.budgets.month, prevMonth))
        .all();

      const now = nowIso();
      const [first, ...rest] = prevBudgets.map((pb) =>
        db
          .insert(s.budgets)
          .values({
            id: budgetId(month, pb.categoryId),
            month,
            categoryId: pb.categoryId,
            amount: pb.amount,
            carryover: pb.carryover,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: s.budgets.id }),
      );
      if (first) await db.batch([first, ...rest]);
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "set_3month_avg": {
      const p = command.payload;
      const month = toMonthInt(p.month);
      const cats = await db
        .select({ id: s.categories.id })
        .from(s.categories)
        .where(eq(s.categories.hidden, false))
        .all();

      const now = nowIso();
      for (const cat of cats) {
        const amounts: number[] = [];
        for (let i = 1; i <= 3; i++) {
          let m = month - i;
          if (m % 100 === 0) m = Math.floor(m / 100 - 1) * 100 + 12;
          const [b] = await db
            .select({ amount: s.budgets.amount })
            .from(s.budgets)
            .where(sql`${s.budgets.month} = ${m} AND ${s.budgets.categoryId} = ${cat.id}`)
            .all();
          if (b) amounts.push(b.amount);
        }
        if (amounts.length > 0) {
          const avg = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
          const id = budgetId(month, cat.id);
          await db
            .insert(s.budgets)
            .values({
              id,
              month,
              categoryId: cat.id,
              amount: avg,
              carryover: false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: s.budgets.id,
              set: { amount: avg, updatedAt: now },
            })
            .run();
        }
      }
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "set_nmonth_avg": {
      const p = command.payload;
      const month = toMonthInt(p.month);
      const n = p.months;
      const cats = await db
        .select({ id: s.categories.id })
        .from(s.categories)
        .where(eq(s.categories.hidden, false))
        .all();

      const now = nowIso();
      for (const cat of cats) {
        const amounts: number[] = [];
        for (let i = 1; i <= n; i++) {
          let m = month - i;
          if (m % 100 === 0) m = Math.floor(m / 100 - 1) * 100 + 12;
          const [b] = await db
            .select({ amount: s.budgets.amount })
            .from(s.budgets)
            .where(sql`${s.budgets.month} = ${m} AND ${s.budgets.categoryId} = ${cat.id}`)
            .all();
          if (b) amounts.push(b.amount);
        }
        if (amounts.length > 0) {
          const avg = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
          const id = budgetId(month, cat.id);
          await db
            .insert(s.budgets)
            .values({
              id,
              month,
              categoryId: cat.id,
              amount: avg,
              carryover: false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: s.budgets.id,
              set: { amount: avg, updatedAt: now },
            })
            .run();
        }
      }
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "set_zero": {
      const p = command.payload;
      const month = toMonthInt(p.month);
      await db.delete(s.budgets).where(eq(s.budgets.month, month)).run();
      const now = nowIso();
      const cats = await db
        .select({ id: s.categories.id })
        .from(s.categories)
        .where(eq(s.categories.hidden, false))
        .all();
      for (const cat of cats) {
        const id = budgetId(month, cat.id);
        await db
          .insert(s.budgets)
          .values({
            id,
            month,
            categoryId: cat.id,
            amount: 0,
            carryover: false,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "apply_goal_templates": {
      const p = command.payload;
      const month = toMonthInt(p.month);
      const cats = await db
        .select({ id: s.categories.id, goalDef: s.categories.goalDef })
        .from(s.categories)
        .where(sql`${s.categories.goalDef} IS NOT NULL AND ${s.categories.hidden} = 0`)
        .all();

      const now = nowIso();
      for (const cat of cats) {
        const goalDef = cat.goalDef ? JSON.parse(cat.goalDef) : null;
        if (!goalDef) continue;
        let amount = 0;
        if (goalDef.type === "monthly") amount = goalDef.amount ?? 0;
        else if (goalDef.type === "percentage")
          amount = goalDef.percentage ? Math.round((100000 * goalDef.percentage) / 100) : 0;
        if (amount > 0) {
          const id = budgetId(month, cat.id);
          await db
            .insert(s.budgets)
            .values({
              id,
              month,
              categoryId: cat.id,
              amount,
              carryover: false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: s.budgets.id,
              set: { amount, updatedAt: now },
            })
            .run();
        }
      }
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "cover_overspending":
    case "transfer_budget": {
      const p = command.payload;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) {
        return { ok: false, error: "Choose a valid budget month" };
      }
      const month = toMonthInt(p.month);
      const now = nowIso();

      const amount = p.amount;
      if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
        return { ok: false, error: "Move amount must be a positive whole number of cents" };
      }
      if (p.from === p.to) return { ok: false, error: "Choose two different categories" };
      const categories = await db
        .select()
        .from(s.categories)
        .where(inArray(s.categories.id, [p.from, p.to]))
        .all();
      if (
        categories.length !== 2 ||
        categories.some((category) => category.isIncome || category.hidden)
      ) {
        return { ok: false, error: "Choose two visible expense categories" };
      }

      const [fromRow] = await db
        .select()
        .from(s.budgets)
        .where(eq(s.budgets.id, budgetId(month, p.from)))
        .all();
      const [toRow] = await db
        .select()
        .from(s.budgets)
        .where(eq(s.budgets.id, budgetId(month, p.to)))
        .all();

      const fromAmount = (fromRow?.amount ?? 0) - amount;
      const toAmount = (toRow?.amount ?? 0) + amount;

      await db.batch([
        db
          .insert(s.budgets)
          .values({
            id: budgetId(month, p.from),
            month,
            categoryId: p.from,
            amount: fromAmount,
            carryover: fromRow?.carryover ?? false,
            createdAt: fromRow?.createdAt ?? now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: s.budgets.id,
            set: { amount: sql`${s.budgets.amount} - ${amount}`, updatedAt: now },
          }),
        db
          .insert(s.budgets)
          .values({
            id: budgetId(month, p.to),
            month,
            categoryId: p.to,
            amount: toAmount,
            carryover: toRow?.carryover ?? false,
            createdAt: toRow?.createdAt ?? now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: s.budgets.id,
            set: { amount: sql`${s.budgets.amount} + ${amount}`, updatedAt: now },
          }),
      ]);

      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    case "hold_for_next_month": {
      const p = command.payload;
      const month = toMonthInt(p.month);
      const now = nowIso();
      await db
        .insert(s.budgetMonths)
        .values({ id: p.month, buffered: p.amount, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: s.budgetMonths.id,
          set: { buffered: p.amount, updatedAt: now },
        })
        .run();
      const result = await computeMonthBudget(db, month);
      return { ok: true, data: { month, budget: result } };
    }

    default:
      return { ok: false, error: "Unknown budget command" };
  }
}
