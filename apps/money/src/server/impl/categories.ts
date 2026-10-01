import { eq, sql } from "drizzle-orm";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { moneyApi } from "../definitions";
import { createDb } from "../d1-access";
import { wrapHandler, validatedJson } from "./wrap-handler";
import {
  CategoriesResponseSchema,
  CategoryGroupsResponseSchema,
  GoalProgressResponseSchema,
} from "../../domain/schemas";
import * as s from "../../db/schema";

type Env = { MONEY_DB: D1Database };

export function createCategoriesGroup(env: Env) {
  return HttpApiBuilder.group(moneyApi, "categories", (handlers) =>
    handlers
      .handleRaw(
        "list",
        wrapHandler(async (): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const rows = await db
            .select({
              id: s.categories.id,
              name: s.categories.name,
              icon: s.categories.icon,
              isIncome: s.categories.isIncome,
              groupId: s.categories.groupId,
              sortOrder: s.categories.sortOrder,
              hidden: s.categories.hidden,
              goalDef: s.categories.goalDef,
              createdAt: s.categories.createdAt,
              updatedAt: s.categories.updatedAt,
              group_name: sql<string | null>`${s.categoryGroups.name}`.as("group_name"),
            })
            .from(s.categories)
            .leftJoin(s.categoryGroups, eq(s.categories.groupId, s.categoryGroups.id))
            .orderBy(s.categoryGroups.sortOrder, s.categories.sortOrder)
            .all();
          return validatedJson(CategoriesResponseSchema, { categories: rows });
        }),
      )
      .handleRaw(
        "groups",
        wrapHandler(async (): Promise<Response> => {
          const db = createDb(env.MONEY_DB);
          const rows = await db
            .select()
            .from(s.categoryGroups)
            .orderBy(s.categoryGroups.sortOrder, s.categoryGroups.name)
            .all();
          return validatedJson(CategoryGroupsResponseSchema, { groups: rows });
        }),
      )
      .handleRaw(
        "goalProgress",
        wrapHandler(async (): Promise<Response> => {
          return validatedJson(GoalProgressResponseSchema, { progress: [] });
        }),
      ),
  );
}
