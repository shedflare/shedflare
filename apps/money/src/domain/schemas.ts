import { createSelectSchema, createInsertSchema } from "drizzle-orm/effect-schema";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as schema from "../db/schema";
import { CategoryIconSchema } from "./category-icons";
import {
  AccountIdSchema,
  TransactionIdSchema,
  CategoryIdSchema,
  CategoryGroupIdSchema,
  PayeeIdSchema,
  ScheduleIdSchema,
  TagIdSchema,
} from "./types";

export const AccountSchema = createSelectSchema(schema.accounts);
export const TransactionSchema = createSelectSchema(schema.transactions);
export const CategorySchema = createSelectSchema(schema.categories);
export const CategoryGroupSchema = createSelectSchema(schema.categoryGroups);
export const PayeeSchema = createSelectSchema(schema.payees);
export const ScheduleSchema = createSelectSchema(schema.schedules);
export const RuleSchema = createSelectSchema(schema.rules);
export const TagSchema = createSelectSchema(schema.tags);
export const TransactionFilterSchema = createSelectSchema(schema.transactionFilters);
export const CustomReportSchema = createSelectSchema(schema.customReports);
export const DashboardWidgetSchema = createSelectSchema(schema.dashboardWidgets);
export const ExchangeRateSchema = createSelectSchema(schema.exchangeRates);

export const BudgetSchema = createSelectSchema(schema.budgets);
export const BudgetMonthSchema = createSelectSchema(schema.budgetMonths);
export const SettingSchema = createSelectSchema(schema.settings);
export const NoteSchema = createSelectSchema(schema.notes);

// Command input schemas (derive from Drizzle insert, strip server-managed fields)
function omitFields<
  const Fields extends Schema.Struct.Fields,
  const Keys extends ReadonlyArray<keyof Fields>,
>(struct: Schema.Struct<Fields>, ...keys: Keys) {
  return struct.mapFields(Struct.omit(keys));
}

export const TransactionInput = omitFields(
  createInsertSchema(schema.transactions),
  "id",
  "createdAt",
  "updatedAt",
);
export const ScheduleInput = omitFields(
  createInsertSchema(schema.schedules),
  "id",
  "createdAt",
  "updatedAt",
);
export const RuleInput = omitFields(
  createInsertSchema(schema.rules),
  "id",
  "createdAt",
  "updatedAt",
);
export const TransactionFilterInput = omitFields(
  createInsertSchema(schema.transactionFilters),
  "id",
  "createdAt",
  "updatedAt",
);
export const CustomReportInput = omitFields(
  createInsertSchema(schema.customReports),
  "id",
  "createdAt",
  "updatedAt",
);
export const DashboardWidgetInput = omitFields(
  createInsertSchema(schema.dashboardWidgets),
  "createdAt",
  "updatedAt",
);

// Shared nullable helpers
export const NullableString = Schema.NullOr(Schema.String);
export const NullableNumber = Schema.NullOr(Schema.Number);

// Parsed transaction (from CSV import)
export const ParsedTransaction = Schema.Struct({
  date: Schema.String,
  amount: Schema.Number,
  payee: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  importedDescription: Schema.optional(Schema.String),
});
export type ParsedTransaction = Schema.Schema.Type<typeof ParsedTransaction>;

// ── API Response Schemas ───────────────────────────────────────────────
// These validate the shapes returned by endpoint handlers before they hit the wire.

// Enriched entity schemas (extend Drizzle schemas with computed/joined fields)

export const AccountApiSchema = Schema.Struct({
  id: AccountIdSchema,
  name: Schema.String,
  offbudget: Schema.Boolean,
  closed: Schema.Boolean,
  sortOrder: Schema.Number,
  openingBalance: Schema.Number,
  balanceCurrent: Schema.Number,
  lastReconciled: Schema.NullOr(Schema.String),
});
export type AccountApi = Schema.Schema.Type<typeof AccountApiSchema>;

export const TransactionApiSchema = Schema.Struct({
  id: TransactionIdSchema,
  accountId: AccountIdSchema,
  categoryId: Schema.NullOr(CategoryIdSchema),
  amount: Schema.Number,
  payee: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  date: Schema.String,
  cleared: Schema.Boolean,
  reconciled: Schema.Boolean,
  importedDescription: Schema.NullOr(Schema.String),
  startingBalanceFlag: Schema.Boolean,
  sortOrder: Schema.NullOr(Schema.Number),
  isParent: Schema.Boolean,
  isChild: Schema.Boolean,
  parentId: Schema.NullOr(TransactionIdSchema),
  transferId: Schema.NullOr(TransactionIdSchema),
  scheduleId: Schema.NullOr(ScheduleIdSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  categoryName: Schema.optional(Schema.NullOr(Schema.String)),
  accountName: Schema.optional(Schema.NullOr(Schema.String)),
  scheduleName: Schema.optional(Schema.NullOr(Schema.String)),
});
export type TransactionApi = Schema.Schema.Type<typeof TransactionApiSchema>;

export const CategoryApiSchema = Schema.Struct({
  id: CategoryIdSchema,
  name: Schema.String,
  icon: Schema.optional(Schema.NullOr(CategoryIconSchema)),
  isIncome: Schema.Boolean,
  groupId: Schema.NullOr(CategoryGroupIdSchema),
  sortOrder: Schema.Number,
  hidden: Schema.Boolean,
  goalDef: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  group_name: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CategoryApi = Schema.Schema.Type<typeof CategoryApiSchema>;

export const PayeeApiSchema = Schema.Struct({
  id: PayeeIdSchema,
  name: Schema.String,
  transferAccountId: Schema.NullOr(AccountIdSchema),
  favorite: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  transactionCount: Schema.Number,
});
export type PayeeApi = Schema.Schema.Type<typeof PayeeApiSchema>;

export const TransactionTagApiSchema = Schema.Struct({
  transactionId: TransactionIdSchema,
  tagId: TagIdSchema,
  tagName: Schema.String,
  tagColor: Schema.NullOr(Schema.String),
});
export type TransactionTagApi = Schema.Schema.Type<typeof TransactionTagApiSchema>;

export const ExchangeRateApiSchema = Schema.Struct({
  id: Schema.String,
  usdToIdr: Schema.Number,
  updatedAt: Schema.String,
});
export type ExchangeRateApi = Schema.Schema.Type<typeof ExchangeRateApiSchema>;

export const BudgetOverviewSchema = Schema.Struct({
  netWorth: Schema.Number,
  onBudget: Schema.Number,
  accountCount: Schema.Number,
  income: Schema.Number,
  expense: Schema.Number,
});
export type BudgetOverview = Schema.Schema.Type<typeof BudgetOverviewSchema>;

export const CategoryBudgetRowSchema = Schema.Struct({
  categoryId: CategoryIdSchema,
  categoryName: Schema.String,
  groupId: Schema.NullOr(CategoryGroupIdSchema),
  groupName: Schema.NullOr(Schema.String),
  budgeted: Schema.Number,
  spent: Schema.Number,
  leftover: Schema.Number,
  leftoverPos: Schema.Number,
  carryover: Schema.Boolean,
});
export type CategoryBudgetRow = Schema.Schema.Type<typeof CategoryBudgetRowSchema>;

export const MonthBudgetSchema = Schema.Struct({
  month: Schema.Number,
  toBudget: Schema.Number,
  buffered: Schema.Number,
  categories: Schema.Array(CategoryBudgetRowSchema),
});
export type MonthBudget = Schema.Schema.Type<typeof MonthBudgetSchema>;

export const NetWorthPointSchema = Schema.Struct({
  date: Schema.String,
  value: Schema.Number,
});

export const CashFlowMonthSchema = Schema.Struct({
  month: Schema.String,
  income: Schema.Number,
  expense: Schema.Number,
});

export const SpendingCategorySchema = Schema.Struct({
  label: Schema.String,
  value: Schema.Number,
  groupName: Schema.NullOr(Schema.String),
});

export const CategorySuggestionSchema = Schema.Struct({
  category_id: Schema.String,
  category_name: Schema.String,
  group_name: Schema.NullOr(Schema.String),
  count: Schema.Number,
});

export const ScheduleDetailSchema = Schema.Struct({
  ...ScheduleSchema.fields,
  account_name: Schema.optional(Schema.NullOr(Schema.String)),
  payee_name: Schema.optional(Schema.NullOr(Schema.String)),
  category_name: Schema.optional(Schema.NullOr(Schema.String)),
  group_name: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CrossoverDataPointSchema = Schema.Struct({
  month: Schema.String,
  balance: Schema.Number,
  investmentIncome: Schema.Number,
  expenses: Schema.Number,
  isProjection: Schema.Boolean,
});

export const CrossoverSchema = Schema.Struct({
  currentBalance: Schema.Number,
  targetNestEgg: Schema.Number,
  medianExpense: Schema.Number,
  savingsRate: Schema.Number,
  yearsToRetire: Schema.NullOr(Schema.Number),
  yearsToRetireFormatted: Schema.String,
  dataPoints: Schema.Array(CrossoverDataPointSchema),
});

export const DashboardExportSchema = Schema.Struct({
  version: Schema.Number,
  exportedAt: Schema.String,
  widgets: Schema.Array(DashboardWidgetSchema),
});

// ── Response wrapper schemas (what each endpoint returns) ──────────────

export const AccountsResponseSchema = Schema.Struct({
  accounts: Schema.Array(AccountApiSchema),
});

export const AccountResponseSchema = AccountApiSchema;

export const AccountTransactionsResponseSchema = Schema.Struct({
  transactions: Schema.Array(TransactionApiSchema),
});

export const AccountTagsResponseSchema = Schema.Struct({
  transactionTags: Schema.Array(TransactionTagApiSchema),
});

export const TransactionsResponseSchema = Schema.Struct({
  transactions: Schema.Array(TransactionApiSchema),
  transactionTags: Schema.optional(Schema.Array(TransactionTagApiSchema)),
});

export const CategoriesResponseSchema = Schema.Struct({
  categories: Schema.Array(CategoryApiSchema),
});

export const CategoryGroupsResponseSchema = Schema.Struct({
  groups: Schema.Array(CategoryGroupSchema),
});

export const GoalProgressItemSchema = Schema.Struct({
  categoryId: Schema.String,
  goalType: Schema.String,
  goalAmount: Schema.Number,
  currentAmount: Schema.Number,
  targetDate: Schema.NullOr(Schema.String),
});

export const GoalProgressResponseSchema = Schema.Struct({
  progress: Schema.Array(GoalProgressItemSchema),
});

export const BudgetOverviewResponseSchema = BudgetOverviewSchema;

export const MonthBudgetResponseSchema = MonthBudgetSchema;

export const PayeesResponseSchema = Schema.Struct({
  payees: Schema.Array(PayeeApiSchema),
});

export const PayeeSuggestionsResponseSchema = Schema.Struct({
  suggestions: Schema.Array(CategorySuggestionSchema),
});

export const SchedulesResponseSchema = Schema.Struct({
  schedules: Schema.Array(ScheduleSchema),
});

export const ScheduleResponseSchema = Schema.Struct({
  schedule: ScheduleDetailSchema,
});

export const DiscoveredScheduleSchema = Schema.Struct({
  payee: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  amount: Schema.Number,
  recurrenceType: Schema.String,
  intervalDays: Schema.Number,
  confidence: Schema.Number,
  transactionCount: Schema.Number,
  matchedTransactionCount: Schema.Number,
});

export const SchedulesDiscoverResponseSchema = Schema.Struct({
  discovered: Schema.Array(DiscoveredScheduleSchema),
});

export const RulesResponseSchema = Schema.Struct({
  rules: Schema.Array(RuleSchema),
});

export const TagsResponseSchema = Schema.Struct({
  tags: Schema.Array(TagSchema),
});

export const FiltersResponseSchema = Schema.Struct({
  filters: Schema.Array(TransactionFilterSchema),
});

export const ReportsNetWorthResponseSchema = Schema.Struct({
  points: Schema.Array(NetWorthPointSchema),
});

export const ReportsCashFlowResponseSchema = Schema.Struct({
  months: Schema.Array(CashFlowMonthSchema),
});

export const ReportsSpendingResponseSchema = Schema.Struct({
  categories: Schema.Array(SpendingCategorySchema),
});

export const ReportsBudgetAnalysisResponseSchema = Schema.Struct({
  categories: Schema.Array(
    Schema.Struct({
      category: Schema.String,
      budgeted: Schema.Number,
      actual: Schema.Number,
    }),
  ),
});

export const ReportsAgeOfMoneyResponseSchema = Schema.Struct({
  days: Schema.NullOr(Schema.Number),
});

export const ReportsCrossoverResponseSchema = CrossoverSchema;

export const ReportsHeatmapResponseSchema = Schema.Struct({
  monthKey: Schema.String,
  income: Schema.Record(Schema.String, Schema.Number),
  expense: Schema.Record(Schema.String, Schema.Number),
});

export const ReportsHeatmapNavSchema = Schema.Struct({
  previous: Schema.String,
  next: Schema.String,
});

export const CustomReportRowSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
  amount: Schema.optional(Schema.Number),
  payee: Schema.optional(Schema.NullOr(Schema.String)),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  cleared: Schema.optional(Schema.Boolean),
  reconciled: Schema.optional(Schema.Boolean),
  category: Schema.optional(Schema.NullOr(Schema.String)),
  account: Schema.optional(Schema.NullOr(Schema.String)),
  month: Schema.optional(Schema.String),
  total: Schema.optional(Schema.Number),
  count: Schema.optional(Schema.Number),
  groupName: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CustomReportResultSchema = Schema.Struct({
  rows: Schema.Array(CustomReportRowSchema),
  groupBy: Schema.NullOr(Schema.String),
});

export const CustomReportsResponseSchema = Schema.Struct({
  reports: Schema.Array(CustomReportSchema),
});

export const DashboardWidgetsResponseSchema = Schema.Struct({
  widgets: Schema.Array(DashboardWidgetSchema),
});

export const DataDumpSchema = Schema.Any;

export const RatesResponseSchema = ExchangeRateApiSchema;

export const SettingsResponseSchema = Schema.Struct({
  settings: Schema.Array(SettingSchema),
});

export const CommandResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Struct({
      id: Schema.optional(Schema.String),
      transactionId: Schema.optional(Schema.String),
      added: Schema.optional(Schema.Number),
      updated: Schema.optional(Schema.Number),
      skipped: Schema.optional(Schema.Number),
      errors: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

// ── Response type aliases (for client-side typing) ─────────────────────

export type AccountsResponse = Schema.Schema.Type<typeof AccountsResponseSchema>;
export type AccountTransactionsResponse = Schema.Schema.Type<
  typeof AccountTransactionsResponseSchema
>;
export type AccountTagsResponse = Schema.Schema.Type<typeof AccountTagsResponseSchema>;
export type TransactionsResponse = Schema.Schema.Type<typeof TransactionsResponseSchema>;
export type CategoriesResponse = Schema.Schema.Type<typeof CategoriesResponseSchema>;
export type CategoryGroupsResponse = Schema.Schema.Type<typeof CategoryGroupsResponseSchema>;
export type GoalProgressResponse = Schema.Schema.Type<typeof GoalProgressResponseSchema>;
export type PayeesResponse = Schema.Schema.Type<typeof PayeesResponseSchema>;
export type PayeeSuggestionsResponse = Schema.Schema.Type<typeof PayeeSuggestionsResponseSchema>;
export type SchedulesResponse = Schema.Schema.Type<typeof SchedulesResponseSchema>;
export type ScheduleResponse = Schema.Schema.Type<typeof ScheduleResponseSchema>;
export type SchedulesDiscoverResponse = Schema.Schema.Type<typeof SchedulesDiscoverResponseSchema>;
export type RulesResponse = Schema.Schema.Type<typeof RulesResponseSchema>;
export type TagsResponse = Schema.Schema.Type<typeof TagsResponseSchema>;
export type FiltersResponse = Schema.Schema.Type<typeof FiltersResponseSchema>;
export type ReportsNetWorthResponse = Schema.Schema.Type<typeof ReportsNetWorthResponseSchema>;
export type ReportsCashFlowResponse = Schema.Schema.Type<typeof ReportsCashFlowResponseSchema>;
export type ReportsSpendingResponse = Schema.Schema.Type<typeof ReportsSpendingResponseSchema>;
export type ReportsBudgetAnalysisResponse = Schema.Schema.Type<
  typeof ReportsBudgetAnalysisResponseSchema
>;
export type ReportsAgeOfMoneyResponse = Schema.Schema.Type<typeof ReportsAgeOfMoneyResponseSchema>;
export type ReportsHeatmapResponse = Schema.Schema.Type<typeof ReportsHeatmapResponseSchema>;
export type CustomReportsResponse = Schema.Schema.Type<typeof CustomReportsResponseSchema>;
export type CustomReportResult = Schema.Schema.Type<typeof CustomReportResultSchema>;
export type DashboardWidgetsResponse = Schema.Schema.Type<typeof DashboardWidgetsResponseSchema>;
export type DashboardExport = Schema.Schema.Type<typeof DashboardExportSchema>;
export type Crossover = Schema.Schema.Type<typeof CrossoverSchema>;
