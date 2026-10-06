import type { FilterCondition } from "./conditions-to-sql";
import { buildFilterSql, parseFilterConditions } from "./conditions-to-sql";
import type { SQL } from "drizzle-orm";
import type { Db } from "./d1-access";
import * as s from "../db/schema";
import { eq } from "drizzle-orm";

export type ParsedTransactionFilter =
  | { status: "valid"; filterSql: SQL | null; conditionsOp: "and" | "or" }
  | { status: "invalid"; error: string };

/**
 * Resolve filter SQL from either a saved filter id or inline conditions JSON.
 * Inline `conditions` take precedence when both are present.
 */
export async function resolveTransactionFilter(db: Db, url: URL): Promise<ParsedTransactionFilter> {
  const conditionsParam = url.searchParams.get("conditions");
  const conditionsOpParam = url.searchParams.get("conditionsOp");
  const filterId = url.searchParams.get("filter");

  let conditions: FilterCondition[] = [];
  let conditionsOp: "and" | "or" = conditionsOpParam === "or" ? "or" : "and";

  if (conditionsParam) {
    try {
      conditions = [...parseFilterConditions(conditionsParam)];
    } catch {
      return { status: "invalid", error: "Invalid transaction filter" };
    }
  } else if (filterId) {
    const [filterRow] = await db
      .select()
      .from(s.transactionFilters)
      .where(eq(s.transactionFilters.id, filterId))
      .all();
    if (filterRow) {
      try {
        conditions = [...parseFilterConditions(filterRow.conditions ?? "[]")];
      } catch {
        return { status: "invalid", error: "Invalid saved transaction filter" };
      }
      conditionsOp = filterRow.conditionsOp === "or" ? "or" : "and";
    }
  }

  try {
    return {
      status: "valid",
      filterSql: buildFilterSql(conditions, conditionsOp),
      conditionsOp,
    };
  } catch {
    return { status: "invalid", error: "Invalid transaction filter" };
  }
}
