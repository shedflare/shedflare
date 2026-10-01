import { index, integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";
import { CATEGORY_ICON_NAMES } from "../domain/category-icons";

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  offbudget: integer("offbudget", { mode: "boolean" }).notNull().default(false),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  balanceCurrent: integer("balance_current"),
  balanceAvailable: integer("balance_available"),
  balanceLimit: integer("balance_limit"),
  mask: text("mask"),
  officialName: text("official_name"),
  lastReconciled: text("last_reconciled"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------
export const categoryGroups = sqliteTable("category_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    icon: text("icon", { enum: CATEGORY_ICON_NAMES }),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    groupId: text("group_id").references(() => categoryGroups.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    goalDef: text("goal_def"), // JSON string of goal template
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_categories_group").on(table.groupId)],
);

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------
export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    amount: integer("amount").notNull(), // cents
    payee: text("payee"),
    notes: text("notes"),
    date: text("date").notNull(), // ISO date YYYY-MM-DD
    cleared: integer("cleared", { mode: "boolean" }).notNull().default(true),
    reconciled: integer("reconciled", { mode: "boolean" }).notNull().default(false),
    importedDescription: text("imported_description"),
    startingBalanceFlag: integer("starting_balance_flag", { mode: "boolean" })
      .notNull()
      .default(false),
    sortOrder: integer("sort_order"),
    isParent: integer("is_parent", { mode: "boolean" }).notNull().default(false),
    isChild: integer("is_child", { mode: "boolean" }).notNull().default(false),
    parentId: text("parent_id"),
    transferId: text("transfer_id"),
    scheduleId: text("schedule_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_transactions_account").on(table.accountId),
    index("idx_transactions_category").on(table.categoryId),
    index("idx_transactions_date").on(table.date),
    index("idx_transactions_parent").on(table.parentId),
  ],
);

// ---------------------------------------------------------------------------
// budgets (per-month, per-category)
// ---------------------------------------------------------------------------
export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(), // "YYYYMM-categoryId"
    month: integer("month").notNull(), // YYYYMM e.g. 202604
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull().default(0), // budgeted in cents
    carryover: integer("carryover", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_budgets_month").on(table.month),
    index("idx_budgets_category").on(table.categoryId),
  ],
);

// ---------------------------------------------------------------------------
// budget_months (per-month metadata)
// ---------------------------------------------------------------------------
export const budgetMonths = sqliteTable("budget_months", {
  id: text("id").primaryKey(), // "YYYY-MM"
  buffered: integer("buffered").notNull().default(0), // money held for next month
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// payees
// ---------------------------------------------------------------------------
export const payees = sqliteTable(
  "payees",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    transferAccountId: text("transfer_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_payees_name").on(table.name)],
);

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------
export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  name: text("name"),
  accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
  payeeId: text("payee_id").references(() => payees.id, { onDelete: "set null" }),
  categoryId: text("category_id").references(() => categories.id, { onDelete: "set null" }),
  amount: integer("amount"),
  startDate: text("start_date"),
  recurrenceRules: text("recurrence_rules").notNull(), // JSON (rschedule config)
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  postsTransaction: integer("posts_transaction", { mode: "boolean" }).notNull().default(false),
  customUpcomingLength: integer("custom_upcoming_length"),
  nextDate: text("next_date"), // cached next occurrence
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------
export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  stage: text("stage").notNull().default("pre"),
  conditionsOp: text("conditions_op").notNull().default("and"),
  conditions: text("conditions").notNull(), // JSON array
  actions: text("actions").notNull(), // JSON array
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: text("created_at").notNull(),
});

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.transactionId, table.tagId] })],
);

// ---------------------------------------------------------------------------
// custom_reports
// ---------------------------------------------------------------------------
export const customReports = sqliteTable("custom_reports", {
  id: text("id").primaryKey(),
  name: text("name"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  dateStatic: integer("date_static", { mode: "boolean" }).notNull().default(false),
  dateRange: text("date_range"),
  mode: text("mode"),
  groupBy: text("group_by"),
  sortBy: text("sort_by").notNull().default("desc"),
  interval: text("interval"),
  balanceType: text("balance_type"),
  showEmpty: integer("show_empty", { mode: "boolean" }).notNull().default(false),
  showOffbudget: integer("show_offbudget", { mode: "boolean" }).notNull().default(false),
  showHidden: integer("show_hidden", { mode: "boolean" }).notNull().default(false),
  showUncategorized: integer("show_uncategorized", { mode: "boolean" }).notNull().default(false),
  trimIntervals: integer("trim_intervals", { mode: "boolean" }).notNull().default(false),
  includeCurrent: integer("include_current", { mode: "boolean" }).notNull().default(true),
  graphType: text("graph_type"),
  conditions: text("conditions").notNull().default("[]"),
  conditionsOp: text("conditions_op").notNull().default("and"),
  metadata: text("metadata"), // widget layout JSON
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// dashboard_widgets
// ---------------------------------------------------------------------------
export const dashboardWidgets = sqliteTable("dashboard_widgets", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  meta: text("meta"), // widget-specific config JSON
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// exchange_rates
// ---------------------------------------------------------------------------
export const exchangeRates = sqliteTable("exchange_rates", {
  id: text("id").primaryKey(), // always "latest"
  usdToIdr: integer("usd_to_idr").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// notes (generic key-value notes for any entity)
// ---------------------------------------------------------------------------
export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  noteableType: text("noteable_type").notNull(),
  noteableId: text("noteable_id").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// transaction_filters (saved searches)
// ---------------------------------------------------------------------------
export const transactionFilters = sqliteTable("transaction_filters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  conditions: text("conditions").notNull(), // JSON array of condition objects
  conditionsOp: text("conditions_op").notNull().default("and"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type NewCategoryGroup = typeof categoryGroups.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;
export type BudgetMonth = typeof budgetMonths.$inferSelect;
export type NewBudgetMonth = typeof budgetMonths.$inferInsert;
export type Payee = typeof payees.$inferSelect;
export type NewPayee = typeof payees.$inferInsert;
export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type TransactionTag = typeof transactionTags.$inferSelect;
export type CustomReport = typeof customReports.$inferSelect;
export type NewCustomReport = typeof customReports.$inferInsert;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type NewDashboardWidget = typeof dashboardWidgets.$inferInsert;
export type ExchangeRate = typeof exchangeRates.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type TransactionFilter = typeof transactionFilters.$inferSelect;
export type NewTransactionFilter = typeof transactionFilters.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
