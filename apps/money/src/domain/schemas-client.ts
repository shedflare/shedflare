import * as S from "effect/Schema";
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

// ── Hand-written Drizzle-derived schemas ─────────────────────────────────
// Avoids importing drizzle-orm/effect-schema which evaluates
// Schema.instanceOf(Buffer) at module level (not available in browsers).

const CategoryGroupSchema = S.Struct({
  id: S.String,
  name: S.String,
  isIncome: S.Boolean,
  sortOrder: S.Number,
  hidden: S.Boolean,
  createdAt: S.String,
  updatedAt: S.String,
});

const ScheduleSchema = S.Struct({
  id: S.String,
  name: S.NullOr(S.String),
  accountId: S.NullOr(S.String),
  payeeId: S.NullOr(S.String),
  categoryId: S.NullOr(S.String),
  amount: S.NullOr(S.Number),
  startDate: S.NullOr(S.String),
  recurrenceRules: S.String,
  active: S.Boolean,
  completed: S.Boolean,
  postsTransaction: S.Boolean,
  customUpcomingLength: S.NullOr(S.Number),
  nextDate: S.NullOr(S.String),
  createdAt: S.String,
  updatedAt: S.String,
});

const RuleSchema = S.Struct({
  id: S.String,
  stage: S.String,
  conditionsOp: S.String,
  conditions: S.String,
  actions: S.String,
  active: S.Boolean,
  deleted: S.Boolean,
  createdAt: S.String,
  updatedAt: S.String,
});

const TagSchema = S.Struct({
  id: S.String,
  name: S.String,
  color: S.NullOr(S.String),
  createdAt: S.String,
});

const TransactionFilterSchema = S.Struct({
  id: S.String,
  name: S.String,
  conditions: S.String,
  conditionsOp: S.String,
  createdAt: S.String,
  updatedAt: S.String,
});

const CustomReportSchema = S.Struct({
  id: S.String,
  name: S.NullOr(S.String),
  startDate: S.NullOr(S.String),
  endDate: S.NullOr(S.String),
  dateStatic: S.Boolean,
  dateRange: S.NullOr(S.String),
  mode: S.NullOr(S.String),
  groupBy: S.NullOr(S.String),
  sortBy: S.String,
  interval: S.NullOr(S.String),
  balanceType: S.NullOr(S.String),
  showEmpty: S.Boolean,
  showOffbudget: S.Boolean,
  showHidden: S.Boolean,
  showUncategorized: S.Boolean,
  trimIntervals: S.Boolean,
  includeCurrent: S.Boolean,
  graphType: S.NullOr(S.String),
  conditions: S.String,
  conditionsOp: S.String,
  metadata: S.NullOr(S.String),
  createdAt: S.String,
  updatedAt: S.String,
});

const DashboardWidgetSchema = S.Struct({
  id: S.String,
  type: S.String,
  x: S.Number,
  y: S.Number,
  width: S.Number,
  height: S.Number,
  meta: S.NullOr(S.String),
  createdAt: S.String,
  updatedAt: S.String,
});

// ── API entity schemas ───────────────────────────────────────────────────

export const AccountApiSchema = S.Struct({
  id: AccountIdSchema,
  name: S.String,
  offbudget: S.Boolean,
  closed: S.Boolean,
  sortOrder: S.Number,
  openingBalance: S.Number,
  balanceCurrent: S.Number,
  lastReconciled: S.NullOr(S.String),
});

const TransactionApiSchema = S.Struct({
  id: TransactionIdSchema,
  accountId: AccountIdSchema,
  categoryId: S.NullOr(CategoryIdSchema),
  amount: S.Number,
  payee: S.NullOr(S.String),
  notes: S.NullOr(S.String),
  date: S.String,
  cleared: S.Boolean,
  reconciled: S.Boolean,
  importedDescription: S.NullOr(S.String),
  startingBalanceFlag: S.Boolean,
  sortOrder: S.NullOr(S.Number),
  isParent: S.Boolean,
  isChild: S.Boolean,
  parentId: S.NullOr(TransactionIdSchema),
  transferId: S.NullOr(TransactionIdSchema),
  scheduleId: S.NullOr(ScheduleIdSchema),
  createdAt: S.String,
  updatedAt: S.String,
  categoryName: S.optional(S.NullOr(S.String)),
  accountName: S.optional(S.NullOr(S.String)),
  scheduleName: S.optional(S.NullOr(S.String)),
});

const CategoryApiSchema = S.Struct({
  id: CategoryIdSchema,
  name: S.String,
  icon: S.optional(S.NullOr(CategoryIconSchema)),
  isIncome: S.Boolean,
  groupId: S.NullOr(CategoryGroupIdSchema),
  sortOrder: S.Number,
  hidden: S.Boolean,
  goalDef: S.NullOr(S.String),
  createdAt: S.String,
  updatedAt: S.String,
  group_name: S.optional(S.NullOr(S.String)),
});

const PayeeApiSchema = S.Struct({
  id: PayeeIdSchema,
  name: S.String,
  transferAccountId: S.NullOr(AccountIdSchema),
  favorite: S.Boolean,
  createdAt: S.String,
  updatedAt: S.String,
  transactionCount: S.Number,
});

const TransactionTagApiSchema = S.Struct({
  transactionId: TransactionIdSchema,
  tagId: TagIdSchema,
  tagName: S.String,
  tagColor: S.NullOr(S.String),
});

const ExchangeRateApiSchema = S.Struct({
  id: S.String,
  usdToIdr: S.Number,
  updatedAt: S.String,
});

const BudgetOverviewSchema = S.Struct({
  netWorth: S.Number,
  onBudget: S.Number,
  accountCount: S.Number,
  income: S.Number,
  expense: S.Number,
});

const CategoryBudgetRowSchema = S.Struct({
  categoryId: CategoryIdSchema,
  categoryName: S.String,
  groupId: S.NullOr(CategoryGroupIdSchema),
  groupName: S.NullOr(S.String),
  budgeted: S.Number,
  spent: S.Number,
  leftover: S.Number,
  leftoverPos: S.Number,
  carryover: S.Boolean,
});

const MonthBudgetSchema = S.Struct({
  month: S.Number,
  toBudget: S.Number,
  buffered: S.Number,
  categories: S.Array(CategoryBudgetRowSchema),
});

const NetWorthPointSchema = S.Struct({
  date: S.String,
  value: S.Number,
});

const CashFlowMonthSchema = S.Struct({
  month: S.String,
  income: S.Number,
  expense: S.Number,
});

const SpendingCategorySchema = S.Struct({
  label: S.String,
  value: S.Number,
  groupName: S.NullOr(S.String),
});

const CategorySuggestionSchema = S.Struct({
  category_id: S.String,
  category_name: S.String,
  group_name: S.NullOr(S.String),
  count: S.Number,
});

const ScheduleDetailSchema = S.Struct({
  ...ScheduleSchema.fields,
  account_name: S.optional(S.NullOr(S.String)),
  payee_name: S.optional(S.NullOr(S.String)),
  category_name: S.optional(S.NullOr(S.String)),
  group_name: S.optional(S.NullOr(S.String)),
});

const CrossoverDataPointSchema = S.Struct({
  month: S.String,
  balance: S.Number,
  investmentIncome: S.Number,
  expenses: S.Number,
  isProjection: S.Boolean,
});

const CrossoverSchema = S.Struct({
  currentBalance: S.Number,
  targetNestEgg: S.Number,
  medianExpense: S.Number,
  savingsRate: S.Number,
  yearsToRetire: S.NullOr(S.Number),
  yearsToRetireFormatted: S.String,
  dataPoints: S.Array(CrossoverDataPointSchema),
});

const _DashboardExportDef = S.Struct({
  version: S.Number,
  exportedAt: S.String,
  widgets: S.Array(DashboardWidgetSchema),
});

const CustomReportRowSchema = S.Struct({
  id: S.optional(S.String),
  date: S.optional(S.String),
  amount: S.optional(S.Number),
  payee: S.optional(S.NullOr(S.String)),
  notes: S.optional(S.NullOr(S.String)),
  cleared: S.optional(S.Boolean),
  reconciled: S.optional(S.Boolean),
  category: S.optional(S.NullOr(S.String)),
  account: S.optional(S.NullOr(S.String)),
  month: S.optional(S.String),
  total: S.optional(S.Number),
  count: S.optional(S.Number),
  groupName: S.optional(S.NullOr(S.String)),
});

const _CustomReportResultDef = S.Struct({
  rows: S.Array(CustomReportRowSchema),
  groupBy: S.NullOr(S.String),
});

// ── Response wrapper schemas ─────────────────────────────────────────────

export const AccountsResponseSchema = S.Struct({
  accounts: S.Array(AccountApiSchema),
});
export const AccountResponseSchema = AccountApiSchema;

export const AccountTransactionsResponseSchema = S.Struct({
  transactions: S.Array(TransactionApiSchema),
});
export const AccountTagsResponseSchema = S.Struct({
  transactionTags: S.Array(TransactionTagApiSchema),
});
export const TransactionsResponseSchema = S.Struct({
  transactions: S.Array(TransactionApiSchema),
  transactionTags: S.optional(S.Array(TransactionTagApiSchema)),
});
export const CategoriesResponseSchema = S.Struct({
  categories: S.Array(CategoryApiSchema),
});
export const CategoryGroupsResponseSchema = S.Struct({
  groups: S.Array(CategoryGroupSchema),
});
export const GoalProgressItemSchema = S.Struct({
  categoryId: S.String,
  goalType: S.String,
  goalAmount: S.Number,
  currentAmount: S.Number,
  targetDate: S.NullOr(S.String),
});
export const GoalProgressResponseSchema = S.Struct({
  progress: S.Array(GoalProgressItemSchema),
});
export const BudgetOverviewResponseSchema = BudgetOverviewSchema;
export const MonthBudgetResponseSchema = MonthBudgetSchema;
export const PayeesResponseSchema = S.Struct({
  payees: S.Array(PayeeApiSchema),
});
export const PayeeSuggestionsResponseSchema = S.Struct({
  suggestions: S.Array(CategorySuggestionSchema),
});
export const SchedulesResponseSchema = S.Struct({
  schedules: S.Array(ScheduleSchema),
});
export const ScheduleResponseSchema = S.Struct({
  schedule: ScheduleDetailSchema,
});
export const DiscoveredScheduleSchema = S.Struct({
  payee: S.String,
  accountId: S.String,
  accountName: S.String,
  categoryId: S.NullOr(S.String),
  amount: S.Number,
  recurrenceType: S.String,
  intervalDays: S.Number,
  confidence: S.Number,
  transactionCount: S.Number,
  matchedTransactionCount: S.Number,
});
export const SchedulesDiscoverResponseSchema = S.Struct({
  discovered: S.Array(DiscoveredScheduleSchema),
});
export const RulesResponseSchema = S.Struct({
  rules: S.Array(RuleSchema),
});
export const TagsResponseSchema = S.Struct({
  tags: S.Array(TagSchema),
});
export const FiltersResponseSchema = S.Struct({
  filters: S.Array(TransactionFilterSchema),
});
export const ReportsNetWorthResponseSchema = S.Struct({
  points: S.Array(NetWorthPointSchema),
});
export const ReportsCashFlowResponseSchema = S.Struct({
  months: S.Array(CashFlowMonthSchema),
});
export const ReportsSpendingResponseSchema = S.Struct({
  categories: S.Array(SpendingCategorySchema),
});
export const ReportsBudgetAnalysisResponseSchema = S.Struct({
  categories: S.Array(
    S.Struct({
      category: S.String,
      budgeted: S.Number,
      actual: S.Number,
    }),
  ),
});
export const ReportsAgeOfMoneyResponseSchema = S.Struct({
  days: S.NullOr(S.Number),
});
export const ReportsCrossoverResponseSchema = CrossoverSchema;
export const ReportsHeatmapResponseSchema = S.Struct({
  monthKey: S.String,
  income: S.Record(S.String, S.Number),
  expense: S.Record(S.String, S.Number),
});
export const CustomReportsResponseSchema = S.Struct({
  reports: S.Array(CustomReportSchema),
});
export const CustomReportResultSchema = _CustomReportResultDef;
export const DashboardWidgetsResponseSchema = S.Struct({
  widgets: S.Array(DashboardWidgetSchema),
});
export const DashboardExportSchema = _DashboardExportDef;
export const RatesResponseSchema = ExchangeRateApiSchema;
export const SettingsResponseSchema = S.Struct({
  settings: S.Array(
    S.Struct({
      id: S.String,
      key: S.String,
      value: S.String,
      updatedAt: S.String,
    }),
  ),
});
export const CommandResponseSchema = S.Union([
  S.Struct({
    ok: S.Literal(true),
    data: S.Struct({
      id: S.optional(S.String),
      transactionId: S.optional(S.String),
      added: S.optional(S.Number),
      updated: S.optional(S.Number),
      skipped: S.optional(S.Number),
      errors: S.optional(S.Array(S.String)),
    }),
  }),
  S.Struct({ ok: S.Literal(false), error: S.String }),
]);

// ── Response type aliases ────────────────────────────────────────────────

export type AccountsResponse = S.Schema.Type<typeof AccountsResponseSchema>;
export type AccountApi = S.Schema.Type<typeof AccountApiSchema>;
export type AccountTransactionsResponse = S.Schema.Type<typeof AccountTransactionsResponseSchema>;
export type AccountTagsResponse = S.Schema.Type<typeof AccountTagsResponseSchema>;
export type TransactionsResponse = S.Schema.Type<typeof TransactionsResponseSchema>;
export type CategoriesResponse = S.Schema.Type<typeof CategoriesResponseSchema>;
export type CategoryGroupsResponse = S.Schema.Type<typeof CategoryGroupsResponseSchema>;
export type GoalProgressResponse = S.Schema.Type<typeof GoalProgressResponseSchema>;
export type BudgetOverview = S.Schema.Type<typeof BudgetOverviewSchema>;
export type MonthBudget = S.Schema.Type<typeof MonthBudgetSchema>;
export type PayeesResponse = S.Schema.Type<typeof PayeesResponseSchema>;
export type PayeeSuggestionsResponse = S.Schema.Type<typeof PayeeSuggestionsResponseSchema>;
export type SchedulesResponse = S.Schema.Type<typeof SchedulesResponseSchema>;
export type ScheduleResponse = S.Schema.Type<typeof ScheduleResponseSchema>;
export type RulesResponse = S.Schema.Type<typeof RulesResponseSchema>;
export type TagsResponse = S.Schema.Type<typeof TagsResponseSchema>;
export type FiltersResponse = S.Schema.Type<typeof FiltersResponseSchema>;
export type ReportsNetWorthResponse = S.Schema.Type<typeof ReportsNetWorthResponseSchema>;
export type ReportsCashFlowResponse = S.Schema.Type<typeof ReportsCashFlowResponseSchema>;
export type ReportsSpendingResponse = S.Schema.Type<typeof ReportsSpendingResponseSchema>;
export type ReportsBudgetAnalysisResponse = S.Schema.Type<
  typeof ReportsBudgetAnalysisResponseSchema
>;
export type ReportsAgeOfMoneyResponse = S.Schema.Type<typeof ReportsAgeOfMoneyResponseSchema>;
export type ReportsHeatmapResponse = S.Schema.Type<typeof ReportsHeatmapResponseSchema>;
export type CustomReportsResponse = S.Schema.Type<typeof CustomReportsResponseSchema>;
export type SchedulesDiscoverResponse = S.Schema.Type<typeof SchedulesDiscoverResponseSchema>;
export type DiscoveredSchedule = S.Schema.Type<typeof DiscoveredScheduleSchema>;
export type CustomReportResult = S.Schema.Type<typeof CustomReportResultSchema>;
export type DashboardWidgetsResponse = S.Schema.Type<typeof DashboardWidgetsResponseSchema>;
export type DashboardExport = S.Schema.Type<typeof DashboardExportSchema>;
export type Crossover = S.Schema.Type<typeof CrossoverSchema>;
export type ExchangeRateApi = S.Schema.Type<typeof ExchangeRateApiSchema>;
export type CommandResponse = S.Schema.Type<typeof CommandResponseSchema>;
export type SettingsResponse = S.Schema.Type<typeof SettingsResponseSchema>;
