/**
 * Smoke test for the test infrastructure itself:
 * confirms we can boot a money-shaped D1 shim and that all expected tables exist.
 */
import { describe, expect, test } from "vite-plus/test";
import { createMoneyTestD1 } from "./d1-shim";
import * as Schema from "effect/Schema";

const TableRowsSchema = Schema.Struct({
  results: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const RateRowsSchema = Schema.Struct({
  results: Schema.Array(Schema.Struct({ id: Schema.String, usd_to_idr: Schema.Number })),
});

describe("test infra", () => {
  test("createMoneyTestD1 initialises all money tables", async () => {
    const d1 = createMoneyTestD1();
    const rows = Schema.decodeUnknownSync(TableRowsSchema)(
      await d1
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(),
    );

    const tables = rows.results.map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "accounts",
        "budget_months",
        "budgets",
        "categories",
        "category_groups",
        "custom_reports",
        "dashboard_widgets",
        "exchange_rates",
        "notes",
        "payees",
        "rules",
        "schedules",
        "settings",
        "tags",
        "transaction_filters",
        "transaction_tags",
        "transactions",
        "transaction_imports",
      ]),
    );
  });

  test("default exchange rate is inserted", async () => {
    const d1 = createMoneyTestD1();
    const { results } = Schema.decodeUnknownSync(RateRowsSchema)(
      await d1.prepare("SELECT id, usd_to_idr FROM exchange_rates").all(),
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("latest");
    expect(results[0].usd_to_idr).toBe(16000);
  });
});
