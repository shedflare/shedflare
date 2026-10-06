import { and, or, sql, type SQL } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import * as Schema from "effect/Schema";

// ── Discriminated union: only valid operator/value combos are representable ──

export interface IsCondition {
  field: string;
  op: "is";
  value: string | number | boolean;
}

export interface IsNotCondition {
  field: string;
  op: "isNot";
  value: string | number;
}

export interface ContainsCondition {
  field: string;
  op: "contains";
  value: string;
}

export interface DoesNotContainCondition {
  field: string;
  op: "doesNotContain";
  value: string;
}

export interface NumericCondition {
  field: string;
  op: "gt" | "gte" | "lt" | "lte";
  value: number;
}

export interface DateComparisonCondition {
  field: "date";
  op: "gt" | "gte" | "lt" | "lte";
  value: string;
}

export interface OneOfCondition {
  field: string;
  op: "oneOf";
  value: ReadonlyArray<string | number>;
}

export interface IsBetweenCondition {
  field: string;
  op: "isbetween";
  value: number;
  value2: number;
}

export type FilterCondition =
  | IsCondition
  | IsNotCondition
  | ContainsCondition
  | DoesNotContainCondition
  | NumericCondition
  | DateComparisonCondition
  | OneOfCondition
  | IsBetweenCondition;

const FilterConditionSchema = Schema.Union([
  Schema.Struct({
    field: Schema.String,
    op: Schema.Literal("is"),
    value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  }),
  Schema.Struct({
    field: Schema.String,
    op: Schema.Literal("isNot"),
    value: Schema.Union([Schema.String, Schema.Number]),
  }),
  Schema.Struct({ field: Schema.String, op: Schema.Literal("contains"), value: Schema.String }),
  Schema.Struct({
    field: Schema.String,
    op: Schema.Literal("doesNotContain"),
    value: Schema.String,
  }),
  Schema.Struct({
    field: Schema.String,
    op: Schema.Literals(["gt", "gte", "lt", "lte"]),
    value: Schema.Number,
  }),
  Schema.Struct({
    field: Schema.Literal("date"),
    op: Schema.Literals(["gt", "gte", "lt", "lte"]),
    value: Schema.String,
  }),
  Schema.Struct({
    field: Schema.String,
    op: Schema.Literal("oneOf"),
    value: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  }),
  Schema.Struct({
    field: Schema.String,
    op: Schema.Literal("isbetween"),
    value: Schema.Number,
    value2: Schema.Number,
  }),
]);

export function parseFilterConditions(json: string): ReadonlyArray<FilterCondition> {
  return Schema.decodeUnknownSync(Schema.Array(FilterConditionSchema))(JSON.parse(json));
}

function colRef(field: string, table: "transactions" | "t"): SQL {
  const qualifier = sql.raw(table);
  switch (field) {
    case "account":
      return sql`${qualifier}.account_id`;
    case "category":
      return sql`${qualifier}.category_id`;
    case "payee":
      return sql`${qualifier}.payee`;
    case "amount":
      return sql`${qualifier}.amount`;
    case "date":
      return sql`${qualifier}.date`;
    case "notes":
      return sql`${qualifier}.notes`;
    case "cleared":
      return sql`${qualifier}.cleared`;
    case "reconciled":
      return sql`${qualifier}.reconciled`;
    default:
      throw new Error(`Unknown filter field: ${field}`);
  }
}

function conditionToSql(cond: FilterCondition, table: "transactions" | "t"): SQL {
  const col = colRef(cond.field, table);

  switch (cond.op) {
    case "is": {
      if (cond.field === "cleared" || cond.field === "reconciled") {
        return sql`${col} = ${cond.value ? 1 : 0}`;
      }
      return sql`${col} = ${cond.value}`;
    }
    case "isNot":
      return sql`${col} != ${cond.value}`;
    case "contains":
      return sql`${col} LIKE ${"%" + cond.value + "%"}`;
    case "doesNotContain":
      return sql`${col} NOT LIKE ${"%" + cond.value + "%"}`;
    case "gt":
      return sql`${col} > ${cond.value}`;
    case "gte":
      return sql`${col} >= ${cond.value}`;
    case "lt":
      return sql`${col} < ${cond.value}`;
    case "lte":
      return sql`${col} <= ${cond.value}`;
    case "oneOf": {
      const arr = cond.value;
      return sql`${col} IN (${sql.join(
        arr.map((v) => sql`${v}`),
        sql`, `,
      )})`;
    }
    case "isbetween":
      return sql`${col} >= ${cond.value} AND ${col} <= ${cond.value2}`;
  }
}

/** Build a Drizzle SQL object for use within typed query builders. */
export function buildFilterSql(
  conditions: ReadonlyArray<FilterCondition>,
  conditionsOp: "and" | "or",
  table: "transactions" | "t" = "transactions",
): SQL | null {
  if (conditions.length === 0) return null;
  const fragments = conditions.map((condition) => conditionToSql(condition, table));
  if (fragments.length === 0) return null;
  return conditionsOp === "or" ? (or(...fragments) ?? null) : (and(...fragments) ?? null);
}

export interface FilterWhereSql {
  whereClause: string;
  params: unknown[];
}

/** Build raw SQL string + params for use with db.all/get/run. */
export function buildFilterWhereSql(
  conditions: ReadonlyArray<FilterCondition>,
  conditionsOp: "and" | "or",
): FilterWhereSql {
  const sqlObj = buildFilterSql(conditions, conditionsOp, "t");
  if (!sqlObj) return { whereClause: "", params: [] };
  const built = new SQLiteDialect().sqlToQuery(sqlObj);
  return { whereClause: built.sql, params: built.params };
}
