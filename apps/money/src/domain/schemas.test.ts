import * as S from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";
import {
  AccountsResponseSchema,
  AccountApiSchema,
  AccountTagsResponseSchema,
  AccountTransactionsResponseSchema,
  BudgetOverviewSchema,
  CategoriesResponseSchema,
  CategoryApiSchema,
  CategoryGroupsResponseSchema,
  CategorySuggestionSchema,
  CommandResponseSchema,
  CrossoverSchema,
  CustomReportResultSchema,
  CustomReportsResponseSchema,
  CustomReportRowSchema,
  DashboardExportSchema,
  DashboardWidgetsResponseSchema,
  ExchangeRateApiSchema,
  FiltersResponseSchema,
  GoalProgressResponseSchema,
  MonthBudgetSchema,
  PayeeApiSchema,
  PayeesResponseSchema,
  PayeeSuggestionsResponseSchema,
  RatesResponseSchema,
  ReportsAgeOfMoneyResponseSchema,
  ReportsBudgetAnalysisResponseSchema,
  ReportsCashFlowResponseSchema,
  ReportsCrossoverResponseSchema,
  ReportsHeatmapResponseSchema,
  ReportsNetWorthResponseSchema,
  ReportsSpendingResponseSchema,
  RulesResponseSchema,
  ScheduleDetailSchema,
  ScheduleResponseSchema,
  SchedulesDiscoverResponseSchema,
  SchedulesResponseSchema,
  SettingsResponseSchema,
  TagsResponseSchema,
  TransactionsResponseSchema,
  type AccountApi,
  type Crossover,
  type ExchangeRateApi,
  type PayeeApi,
} from "./schemas";
import { AccountIdSchema, PayeeIdSchema } from "./types";

function decode<SchemaType extends Parameters<typeof S.decodeUnknownSync>[0], Value>(
  schema: SchemaType,
  value: Value,
): SchemaType["Type"] {
  return S.decodeUnknownSync(schema)(value);
}

describe("id brand schemas", () => {
  // Branded types are constructed via castId at trust boundaries; we verify
  // by exercising the broader schemas that consume them (above) rather than
  // decoding a bare brand directly.
  test.skip("AccountIdSchema is a Schema instance (skipped: brand AST is private in effect@4 beta)", () => {});
});

describe("AccountApiSchema", () => {
  const valid: AccountApi = {
    id: decode(AccountIdSchema, "acct_1"),
    name: "Checking",
    offbudget: false,
    closed: false,
    sortOrder: 0,
    openingBalance: 100,
    balanceCurrent: 100,
    lastReconciled: null,
  };

  test("decodes a valid account", () => {
    expect(decode(AccountApiSchema, valid)).toEqual(valid);
  });

  test("rejects missing required fields", () => {
    const { name, ...rest } = valid;
    void name;
    expect(() => decode(AccountApiSchema, rest)).toThrow();
  });

  test("rejects wrong types for boolean fields", () => {
    expect(() => decode(AccountApiSchema, { ...valid, offbudget: "yes" })).toThrow();
  });
});

describe("CategoryApiSchema", () => {
  const valid = {
    id: "cat_1",
    name: "Groceries",
    isIncome: false,
    groupId: null,
    sortOrder: 0,
    hidden: false,
    goalDef: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  test("decodes a valid category", () => {
    expect(decode(CategoryApiSchema, valid)).toEqual(valid);
  });

  test("rejects wrong id type", () => {
    expect(() => decode(CategoryApiSchema, { ...valid, id: 42 })).toThrow();
  });
});

describe("PayeeApiSchema", () => {
  const valid: PayeeApi = {
    id: decode(PayeeIdSchema, "pay_1"),
    name: "Store",
    transferAccountId: null,
    favorite: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    transactionCount: 0,
  };

  test("decodes a valid payee", () => {
    expect(decode(PayeeApiSchema, valid)).toEqual(valid);
  });
});

describe("ExchangeRateApiSchema", () => {
  const valid: ExchangeRateApi = {
    id: "latest",
    usdToIdr: 16000,
    updatedAt: "2026-01-01T00:00:00Z",
  };

  test("decodes a valid exchange rate", () => {
    expect(decode(ExchangeRateApiSchema, valid)).toEqual(valid);
  });

  test("RatesResponseSchema is the same schema", () => {
    expect(RatesResponseSchema).toBe(ExchangeRateApiSchema);
  });
});

describe("Response wrapper schemas", () => {
  test("AccountsResponseSchema wraps a list", () => {
    const out = decode(AccountsResponseSchema, { accounts: [] });
    expect(out.accounts).toEqual([]);
  });

  test("AccountTransactionsResponseSchema requires transactions", () => {
    expect(() => decode(AccountTransactionsResponseSchema, {})).toThrow();
  });

  test("AccountTagsResponseSchema requires transactionTags", () => {
    expect(() => decode(AccountTagsResponseSchema, {})).toThrow();
  });

  test("CategoriesResponseSchema requires categories", () => {
    expect(() => decode(CategoriesResponseSchema, {})).toThrow();
  });

  test("CategoryGroupsResponseSchema requires groups", () => {
    expect(() => decode(CategoryGroupsResponseSchema, {})).toThrow();
  });

  test("PayeesResponseSchema wraps a list", () => {
    expect(decode(PayeesResponseSchema, { payees: [] }).payees).toEqual([]);
  });

  test("PayeeSuggestionsResponseSchema accepts empty suggestions", () => {
    expect(decode(PayeeSuggestionsResponseSchema, { suggestions: [] }).suggestions).toEqual([]);
  });

  test("CategorySuggestionSchema allows null group_name", () => {
    expect(
      decode(CategorySuggestionSchema, {
        category_id: "cat_1",
        category_name: "X",
        group_name: null,
        count: 3,
      }),
    ).toEqual({
      category_id: "cat_1",
      category_name: "X",
      group_name: null,
      count: 3,
    });
  });

  test("TransactionsResponseSchema requires transactions", () => {
    expect(() => decode(TransactionsResponseSchema, {})).toThrow();
  });

  test("RulesResponseSchema requires rules", () => {
    expect(() => decode(RulesResponseSchema, {})).toThrow();
  });

  test("TagsResponseSchema requires tags", () => {
    expect(() => decode(TagsResponseSchema, {})).toThrow();
  });

  test("FiltersResponseSchema requires filters", () => {
    expect(() => decode(FiltersResponseSchema, {})).toThrow();
  });
});

describe("Budget schemas", () => {
  test("BudgetOverviewSchema decodes a complete overview", () => {
    const overview = decode(BudgetOverviewSchema, {
      netWorth: 1000,
      onBudget: 800,
      accountCount: 3,
      income: 5000,
      expense: 3000,
    });
    expect(overview.netWorth).toBe(1000);
  });

  test("MonthBudgetSchema accepts empty categories", () => {
    const empty = {
      month: 202604,
      toBudget: 0,
      buffered: 0,
      fromLastMonth: 0,
      overspentLastMonth: 0,
      categories: [],
    };
    expect(decode(MonthBudgetSchema, empty)).toEqual(empty);
  });
});

describe("Schedules", () => {
  test("SchedulesResponseSchema requires schedules", () => {
    expect(() => decode(SchedulesResponseSchema, {})).toThrow();
  });

  test("ScheduleResponseSchema wraps a single schedule", () => {
    const sched = {
      id: "sch_1",
      name: null,
      accountId: null,
      payeeId: null,
      categoryId: null,
      amount: 100,
      startDate: "2026-01-01",
      recurrenceRules: "FREQ=MONTHLY",
      active: true,
      completed: false,
      postsTransaction: false,
      customUpcomingLength: null,
      nextDate: "2026-02-01",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => decode(ScheduleDetailSchema, sched)).not.toThrow();
    expect(() => decode(ScheduleResponseSchema, { schedule: sched })).not.toThrow();
  });

  test("SchedulesDiscoverResponseSchema accepts an empty array", () => {
    const out = decode(SchedulesDiscoverResponseSchema, {
      discovered: [],
    });
    expect(out.discovered).toEqual([]);
  });
});

describe("Reports", () => {
  test("ReportsNetWorthResponseSchema decodes points", () => {
    expect(
      decode(ReportsNetWorthResponseSchema, {
        points: [
          { date: "2026-01", value: 100 },
          { date: "2026-02", value: 200 },
        ],
      }).points,
    ).toHaveLength(2);
  });

  test("ReportsCashFlowResponseSchema decodes months", () => {
    expect(
      decode(ReportsCashFlowResponseSchema, {
        months: [{ month: "2026-01", income: 100, expense: 50 }],
      }).months,
    ).toHaveLength(1);
  });

  test("ReportsSpendingResponseSchema requires categories", () => {
    expect(() => decode(ReportsSpendingResponseSchema, {})).toThrow();
  });

  test("ReportsBudgetAnalysisResponseSchema accepts empty categories", () => {
    expect(decode(ReportsBudgetAnalysisResponseSchema, { categories: [] }).categories).toEqual([]);
  });

  test("ReportsAgeOfMoneyResponseSchema decodes a number of days", () => {
    expect(decode(ReportsAgeOfMoneyResponseSchema, { days: 30 }).days).toBe(30);
  });

  test("ReportsHeatmapResponseSchema decodes daily income/expense maps", () => {
    const out = decode(ReportsHeatmapResponseSchema, {
      monthKey: "2026-04",
      income: { "2026-04-01": 100 },
      expense: { "2026-04-01": -50 },
    });
    expect(out.income["2026-04-01"]).toBe(100);
    expect(out.expense["2026-04-01"]).toBe(-50);
  });

  test("ReportsCrossoverResponseSchema decodes a full crossover result", () => {
    const sample: Crossover = {
      currentBalance: 10000,
      targetNestEgg: 500000,
      medianExpense: 3000,
      savingsRate: 0.2,
      yearsToRetire: 12.5,
      yearsToRetireFormatted: "12y 6m",
      dataPoints: [
        {
          month: "2026-04",
          balance: 10000,
          investmentIncome: 33,
          expenses: 3000,
          isProjection: false,
        },
      ],
    };
    const out = decode(ReportsCrossoverResponseSchema, sample);
    expect(out.yearsToRetireFormatted).toBe("12y 6m");
  });

  test("ReportsCrossoverResponseSchema accepts null yearsToRetire", () => {
    const out: Crossover = {
      currentBalance: 0,
      targetNestEgg: 0,
      medianExpense: 0,
      savingsRate: 0,
      yearsToRetire: null,
      yearsToRetireFormatted: "50y+",
      dataPoints: [],
    };
    expect(decode(ReportsCrossoverResponseSchema, out).yearsToRetire).toBeNull();
  });

  test("CrossoverSchema is the same as ReportsCrossoverResponseSchema", () => {
    expect(ReportsCrossoverResponseSchema).toBe(CrossoverSchema);
  });
});

describe("Custom reports", () => {
  test("CustomReportsResponseSchema requires reports", () => {
    expect(() => decode(CustomReportsResponseSchema, {})).toThrow();
  });

  test("CustomReportResultSchema accepts empty rows", () => {
    const out = decode(CustomReportResultSchema, { rows: [], groupBy: null });
    expect(out.rows).toEqual([]);
    expect(out.groupBy).toBeNull();
  });

  test("CustomReportRowSchema accepts all-optional fields", () => {
    expect(() => decode(CustomReportRowSchema, {})).not.toThrow();
  });
});

describe("Dashboard", () => {
  test("DashboardWidgetsResponseSchema decodes an empty list", () => {
    expect(decode(DashboardWidgetsResponseSchema, { widgets: [] }).widgets).toEqual([]);
  });

  test("DashboardExportSchema decodes a complete export", () => {
    const out = decode(DashboardExportSchema, {
      version: 1,
      exportedAt: "2026-04-15T00:00:00Z",
      widgets: [],
    });
    expect(out.version).toBe(1);
  });
});

describe("Settings", () => {
  test("SettingsResponseSchema decodes a list of settings", () => {
    expect(
      decode(SettingsResponseSchema, {
        settings: [
          {
            id: "display_currency",
            key: "display_currency",
            value: "USD",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }).settings,
    ).toHaveLength(1);
  });
});

describe("Goal progress", () => {
  test("GoalProgressResponseSchema accepts an empty progress array", () => {
    expect(decode(GoalProgressResponseSchema, { progress: [] }).progress).toEqual([]);
  });
});

describe("CommandResponseSchema", () => {
  test("decodes the ok=true branch", () => {
    expect(decode(CommandResponseSchema, { ok: true, data: { id: "x" } })).toEqual({
      ok: true,
      data: { id: "x" },
    });
  });

  test("decodes the ok=false branch", () => {
    expect(decode(CommandResponseSchema, { ok: false, error: "boom" })).toEqual({
      ok: false,
      error: "boom",
    });
  });

  test("rejects an unrecognised discriminator", () => {
    expect(() => decode(CommandResponseSchema, { ok: "maybe" })).toThrow();
  });
});
