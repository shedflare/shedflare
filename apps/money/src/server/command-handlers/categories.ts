import { eq } from "drizzle-orm";
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
  | "reorder_categories";

type CategoryInvocation = Extract<CommandInvocation, { commandType: CategoryCommand }>;

export async function handleCategoryCommands(
  command: CategoryInvocation,
  db: Db,
): Promise<CommandResult> {
  switch (command.commandType) {
    case "create_category": {
      const p = command.payload;
      const row = createCategory(p);
      await db.insert(s.categories).values(row).run();
      return { ok: true, data: { id: row.id } };
    }

    case "update_category": {
      const p = command.payload;
      const set: Partial<typeof s.categories.$inferInsert> = { updatedAt: nowIso() };
      if (p.name !== undefined) set.name = p.name;
      if (p.hidden !== undefined) set.hidden = p.hidden;
      if (p.groupId !== undefined) set.groupId = p.groupId;
      if (p.goalDef !== undefined) set.goalDef = p.goalDef;
      if (p.icon !== undefined) set.icon = p.icon;
      await db.update(s.categories).set(set).where(eq(s.categories.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "delete_category": {
      const p = command.payload;
      if (p.transferToId) {
        await db
          .update(s.transactions)
          .set({ categoryId: p.transferToId })
          .where(eq(s.transactions.categoryId, p.id))
          .run();
      }
      await db.delete(s.categories).where(eq(s.categories.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "create_category_group": {
      const p = command.payload;
      const row = createCategoryGroup(p);
      await db.insert(s.categoryGroups).values(row).run();
      return { ok: true, data: { id: row.id } };
    }

    case "update_category_group": {
      const p = command.payload;
      const set: Partial<typeof s.categoryGroups.$inferInsert> = { updatedAt: nowIso() };
      if (p.name !== undefined) set.name = p.name;
      if (p.hidden !== undefined) set.hidden = p.hidden;
      if (p.isIncome !== undefined) set.isIncome = p.isIncome;
      await db.update(s.categoryGroups).set(set).where(eq(s.categoryGroups.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    case "reorder_categories": {
      const p = command.payload;
      const now = nowIso();
      for (let i = 0; i < p.ids.length; i++) {
        await db
          .update(s.categories)
          .set({ sortOrder: i, updatedAt: now })
          .where(eq(s.categories.id, p.ids[i]))
          .run();
      }
      return { ok: true, data: { count: p.ids.length } };
    }

    case "delete_category_group": {
      const p = command.payload;
      if (p.transferToGroupId) {
        await db
          .update(s.categories)
          .set({ groupId: p.transferToGroupId })
          .where(eq(s.categories.groupId, p.id))
          .run();
      } else {
        await db
          .update(s.categories)
          .set({ groupId: null })
          .where(eq(s.categories.groupId, p.id))
          .run();
      }
      await db.delete(s.categoryGroups).where(eq(s.categoryGroups.id, p.id)).run();
      return { ok: true, data: { id: p.id } };
    }

    default:
      return { ok: false, error: "Unknown category command" };
  }
}
