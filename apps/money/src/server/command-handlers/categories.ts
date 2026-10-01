import { eq, inArray, max } from "drizzle-orm";
import type { Db } from "../d1-access";
import * as s from "../../db/schema";
import { createCategory, createCategoryGroup } from "../../domain/factories";
import { nowIso } from "../../domain/types";
import type { CommandInvocation } from "../../domain/commands";
import type { CommandResult } from "../../domain/types";

type CategoryCommand =
  | "create_category"
  | "update_category"
  | "delete_category"
  | "create_category_group"
  | "update_category_group"
  | "delete_category_group"
  | "reorder_categories"
  | "reorder_category_groups";
type CategoryInvocation = Extract<CommandInvocation, { commandType: CategoryCommand }>;
export async function handleCategoryCommands(
  command: CategoryInvocation,
  db: Db,
): Promise<CommandResult> {
  switch (command.commandType) {
    case "create_category": {
      const p = command.payload;
      if (!p.name.trim()) return { ok: false, error: "Enter a category name" };
      const [group] = p.groupId
        ? await db.select().from(s.categoryGroups).where(eq(s.categoryGroups.id, p.groupId)).all()
        : [];
      if (p.groupId && !group) return { ok: false, error: "Choose an existing group" };
      const isIncome = p.isIncome ?? group?.isIncome ?? false;
      if (group && group.isIncome !== isIncome)
        return { ok: false, error: "Choose a group of the same type" };
      const [order] = await db
        .select({ last: max(s.categories.sortOrder) })
        .from(s.categories)
        .all();
      const row = createCategory({
        ...p,
        name: p.name.trim(),
        isIncome,
        sortOrder: (order?.last ?? -1) + 1,
      });
      await db.insert(s.categories).values(row).run();
      return { ok: true, data: { id: row.id } };
    }
    case "update_category": {
      const p = command.payload;
      const [category] = await db
        .select()
        .from(s.categories)
        .where(eq(s.categories.id, p.id))
        .all();
      if (!category) return { ok: false, error: "Category not found" };
      if (p.name !== undefined && !p.name.trim())
        return { ok: false, error: "Enter a category name" };
      if (p.groupId && p.groupId !== category.groupId) {
        const [group] = await db
          .select()
          .from(s.categoryGroups)
          .where(eq(s.categoryGroups.id, p.groupId))
          .all();
        if (!group || group.isIncome !== category.isIncome)
          return { ok: false, error: "Choose a group of the same type" };
      }
      const set: Partial<typeof s.categories.$inferInsert> = { updatedAt: nowIso() };
      if (p.name !== undefined) set.name = p.name.trim();
      if (p.hidden !== undefined) set.hidden = p.hidden;
      if (p.groupId !== undefined) set.groupId = p.groupId;
      if (p.goalDef !== undefined) set.goalDef = p.goalDef;
      if (p.icon !== undefined) set.icon = p.icon;
      await db.update(s.categories).set(set).where(eq(s.categories.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }
    case "delete_category": {
      const p = command.payload;
      const [category] = await db
        .select()
        .from(s.categories)
        .where(eq(s.categories.id, p.id))
        .all();
      if (!category) return { ok: false, error: "Category not found" };
      if (p.transferToId) {
        const [target] = await db
          .select()
          .from(s.categories)
          .where(eq(s.categories.id, p.transferToId))
          .all();
        if (!target || target.id === category.id || target.isIncome !== category.isIncome)
          return { ok: false, error: "Choose another category of the same type" };
      }
      await db.batch([
        db
          .update(s.transactions)
          .set({ categoryId: p.transferToId ?? null, updatedAt: nowIso() })
          .where(eq(s.transactions.categoryId, p.id)),
        db
          .update(s.schedules)
          .set({ categoryId: p.transferToId ?? null, updatedAt: nowIso() })
          .where(eq(s.schedules.categoryId, p.id)),
        db.delete(s.budgets).where(eq(s.budgets.categoryId, p.id)),
        db.delete(s.categories).where(eq(s.categories.id, p.id)),
      ]);
      return { ok: true, data: { id: p.id } };
    }
    case "create_category_group": {
      const p = command.payload;
      const name = p.name.trim();
      if (!name) return { ok: false, error: "Enter a group name" };
      const [existing] = await db
        .select({ id: s.categoryGroups.id })
        .from(s.categoryGroups)
        .where(eq(s.categoryGroups.name, name))
        .all();
      if (existing) return { ok: false, error: "That group name is already used" };
      const [order] = await db
        .select({ last: max(s.categoryGroups.sortOrder) })
        .from(s.categoryGroups)
        .all();
      const row = createCategoryGroup({ ...p, name, sortOrder: (order?.last ?? -1) + 1 });
      await db.insert(s.categoryGroups).values(row).run();
      return { ok: true, data: { id: row.id } };
    }
    case "update_category_group": {
      const p = command.payload;
      const [group] = await db
        .select()
        .from(s.categoryGroups)
        .where(eq(s.categoryGroups.id, p.id))
        .all();
      if (!group) return { ok: false, error: "Group not found" };
      if (p.name !== undefined) {
        if (!p.name.trim()) return { ok: false, error: "Enter a group name" };
        const [existing] = await db
          .select({ id: s.categoryGroups.id })
          .from(s.categoryGroups)
          .where(eq(s.categoryGroups.name, p.name.trim()))
          .all();
        if (existing && existing.id !== p.id)
          return { ok: false, error: "That group name is already used" };
      }
      const set: Partial<typeof s.categoryGroups.$inferInsert> = { updatedAt: nowIso() };
      if (p.name !== undefined) set.name = p.name.trim();
      if (p.hidden !== undefined) set.hidden = p.hidden;
      if (p.isIncome !== undefined) set.isIncome = p.isIncome;
      await db.update(s.categoryGroups).set(set).where(eq(s.categoryGroups.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }
    case "reorder_categories": {
      const { ids } = command.payload;
      if (!ids.length) return { ok: true, data: { count: 0 } };
      if (new Set(ids).size !== ids.length)
        return { ok: false, error: "Choose distinct categories" };
      const rows = await db
        .select({ id: s.categories.id })
        .from(s.categories)
        .where(inArray(s.categories.id, ids))
        .all();
      if (rows.length !== ids.length)
        return { ok: false, error: "Category order changed. Reload and try again" };
      const now = nowIso();
      const statements = ids.map((id, index) =>
        db
          .update(s.categories)
          .set({ sortOrder: index, updatedAt: now })
          .where(eq(s.categories.id, id)),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      return { ok: true, data: { count: ids.length } };
    }
    case "reorder_category_groups": {
      const { ids } = command.payload;
      if (!ids.length) return { ok: true, data: { count: 0 } };
      if (new Set(ids).size !== ids.length) return { ok: false, error: "Choose distinct groups" };
      const rows = await db
        .select({ id: s.categoryGroups.id })
        .from(s.categoryGroups)
        .where(inArray(s.categoryGroups.id, ids))
        .all();
      if (rows.length !== ids.length)
        return { ok: false, error: "Group order changed. Reload and try again" };
      const now = nowIso();
      const statements = ids.map((id, index) =>
        db
          .update(s.categoryGroups)
          .set({ sortOrder: index, updatedAt: now })
          .where(eq(s.categoryGroups.id, id)),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      return { ok: true, data: { count: ids.length } };
    }
    case "delete_category_group": {
      const p = command.payload;
      const [group] = await db
        .select()
        .from(s.categoryGroups)
        .where(eq(s.categoryGroups.id, p.id))
        .all();
      if (!group) return { ok: false, error: "Group not found" };
      if (p.transferToGroupId) {
        const [target] = await db
          .select()
          .from(s.categoryGroups)
          .where(eq(s.categoryGroups.id, p.transferToGroupId))
          .all();
        if (!target || target.id === p.id || target.isIncome !== group.isIncome)
          return { ok: false, error: "Choose another group of the same type" };
      }
      await db.batch([
        db
          .update(s.categories)
          .set({ groupId: p.transferToGroupId ?? null, updatedAt: nowIso() })
          .where(eq(s.categories.groupId, p.id)),
        db.delete(s.categoryGroups).where(eq(s.categoryGroups.id, p.id)),
      ]);
      return { ok: true, data: { id: p.id } };
    }
  }
}
