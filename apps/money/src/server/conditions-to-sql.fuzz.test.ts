/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { applyDrizzleMigrations } from "@shedflare/test-utils/migrations";
import { describe, expect, test } from "vite-plus/test";
import { createFuzzRandom, type FuzzRandom } from "../test/fuzz";
import { buildFilterWhereSql, type FilterCondition } from "./conditions-to-sql";
import * as Schema from "effect/Schema";

const SEED = 0xf17e12;
const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

interface TransactionFixture {
  id: string;
  account: string;
  category: string;
  amount: number;
  date: string;
  notes: string | null;
  cleared: number;
  reconciled: number;
}

const FIXTURES: readonly TransactionFixture[] = [
  {
    id: "txn_01",
    account: "checking",
    category: "food",
    amount: -1_250,
    date: "2026-01-05",
    notes: "Coffee and bagel",
    cleared: 1,
    reconciled: 0,
  },
  {
    id: "txn_02",
    account: "checking",
    category: "salary",
    amount: 500_000,
    date: "2026-01-31",
    notes: "Monthly salary",
    cleared: 1,
    reconciled: 1,
  },
  {
    id: "txn_03",
    account: "credit",
    category: "travel",
    amount: -98_765,
    date: "2026-02-14",
    notes: "Airport_train",
    cleared: 0,
    reconciled: 0,
  },
  {
    id: "txn_04",
    account: "savings",
    category: "interest",
    amount: 432,
    date: "2026-02-28",
    notes: null,
    cleared: 1,
    reconciled: 1,
  },
  {
    id: "txn_05",
    account: "credit",
    category: "food",
    amount: 0,
    date: "2026-03-01",
    notes: "x' OR 1=1 --",
    cleared: 0,
    reconciled: 1,
  },
];

function toSqliteParams(params: readonly unknown[]): SQLInputValue[] {
  const SqlInputSchema = Schema.Union([Schema.Null, Schema.Number, Schema.BigInt, Schema.String]);
  return params.map((value) => Schema.decodeUnknownSync(SqlInputSchema)(value));
}

function valueFor(row: TransactionFixture, field: string): string | number | null {
  switch (field) {
    case "account":
      return row.account;
    case "category":
      return row.category;
    case "amount":
      return row.amount;
    case "date":
      return row.date;
    case "notes":
      return row.notes;
    case "cleared":
      return row.cleared;
    case "reconciled":
      return row.reconciled;
    default:
      throw new Error(`Unexpected generated field: ${field}`);
  }
}

function matches(row: TransactionFixture, condition: FilterCondition): boolean {
  const raw = valueFor(row, condition.field);
  if (raw === null) return false;

  switch (condition.op) {
    case "is": {
      const expected =
        condition.field === "cleared" || condition.field === "reconciled"
          ? condition.value
            ? 1
            : 0
          : condition.value;
      return raw === expected;
    }
    case "isNot":
      return raw !== condition.value;
    case "contains":
      return String(raw).toLowerCase().includes(condition.value.toLowerCase());
    case "doesNotContain":
      return !String(raw).toLowerCase().includes(condition.value.toLowerCase());
    case "gt":
      return condition.field === "date"
        ? String(raw) > String(condition.value)
        : Number(raw) > Number(condition.value);
    case "gte":
      return condition.field === "date"
        ? String(raw) >= String(condition.value)
        : Number(raw) >= Number(condition.value);
    case "lt":
      return condition.field === "date"
        ? String(raw) < String(condition.value)
        : Number(raw) < Number(condition.value);
    case "lte":
      return condition.field === "date"
        ? String(raw) <= String(condition.value)
        : Number(raw) <= Number(condition.value);
    case "oneOf":
      return condition.value.includes(raw);
    case "isbetween":
      return Number(raw) >= condition.value && Number(raw) <= condition.value2;
  }
}

function generateCondition(random: FuzzRandom): FilterCondition {
  const stringFields = ["account", "category", "date"] as const;
  const stringValues = [
    "checking",
    "credit",
    "savings",
    "food",
    "salary",
    "travel",
    "2026-01-05",
    "2026-02-28",
    "missing",
    "x' OR 1=1 --",
  ] as const;
  const numericValues = [-100_000, -1_250, -1, 0, 1, 432, 500_000] as const;

  switch (random.int(0, 4)) {
    case 0: {
      const field = random.pick(stringFields);
      const value = random.pick(stringValues);
      const op = random.pick(["is", "isNot"] as const);
      return { field, op, value };
    }
    case 1: {
      const op = random.pick(["is", "isNot", "gt", "gte", "lt", "lte"] as const);
      return { field: "amount", op, value: random.pick(numericValues) };
    }
    case 2: {
      const value = random.pick(["coffee", "salary", "train", "missing", "x' OR 1=1 --"] as const);
      const op = random.pick(["contains", "doesNotContain"] as const);
      return { field: "notes", op, value };
    }
    case 3: {
      const field = random.pick(["cleared", "reconciled"] as const);
      return { field, op: "is", value: random.bool() };
    }
    default: {
      if (random.bool()) {
        const values = Array.from({ length: random.int(0, 4) }, () => random.pick(numericValues));
        return { field: "amount", op: "oneOf", value: values };
      }
      const first = random.pick(numericValues);
      const second = random.pick(numericValues);
      return {
        field: "amount",
        op: "isbetween",
        value: Math.min(first, second),
        value2: Math.max(first, second),
      };
    }
  }
}

describe("transaction filter SQL fuzzing", () => {
  test(`matches a reference evaluator across 1,000 queries (seed ${SEED})`, () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    applyDrizzleMigrations(sqlite, MIGRATIONS_DIR);
    const insert = sqlite.prepare(`
      INSERT INTO transactions (
        id,
        account_id,
        category_id,
        amount,
        date,
        notes,
        cleared,
        reconciled,
        starting_balance_flag,
        is_parent,
        is_child,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of FIXTURES) {
      insert.run(
        row.id,
        row.account,
        row.category,
        row.amount,
        row.date,
        row.notes,
        row.cleared,
        row.reconciled,
        0,
        0,
        0,
        row.date,
        row.date,
      );
    }

    const random = createFuzzRandom(SEED);
    for (let iteration = 0; iteration < 1_000; iteration++) {
      const conditions = Array.from({ length: random.int(1, 6) }, () => generateCondition(random));
      const conditionsOp = random.bool() ? "and" : "or";
      const { whereClause, params } = buildFilterWhereSql(conditions, conditionsOp);
      const actual = sqlite
        .prepare(`SELECT id FROM transactions t WHERE ${whereClause} ORDER BY id`)
        .all(...toSqliteParams(params))
        .map((row) => String(row.id));
      const expected = FIXTURES.filter((row) =>
        conditionsOp === "and"
          ? conditions.every((condition) => matches(row, condition))
          : conditions.some((condition) => matches(row, condition)),
      ).map((row) => row.id);

      expect(actual, `iteration ${iteration}, conditions ${JSON.stringify(conditions)}`).toEqual(
        expected,
      );
    }
  });
});
