import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SYNC_PROTOCOL_VERSION = "money-v1";

export const SYNC_COMMAND_TYPES = [
  "setup_money",
  "create_account",
  "update_account",
  "delete_account",
  "close_account",
  "reopen_account",
  "reorder_accounts",
  "create_transaction",
  "create_account_transfer",
  "delete_account_transfer",
  "reconcile_account",
  "update_transaction",
  "delete_transaction",
  "split_transaction",
  "import_transactions",
  "undo_transaction_import",
  "set_budget_amount",
  "allocate_budget",
  "set_budget_plan",
  "set_budget_carryover",
  "set_buffer",
  "copy_previous_month",
  "set_3month_avg",
  "set_nmonth_avg",
  "set_zero",
  "apply_goal_templates",
  "cover_overspending",
  "transfer_budget",
  "hold_for_next_month",
  "create_category",
  "update_category",
  "delete_category",
  "create_category_group",
  "update_category_group",
  "delete_category_group",
  "reorder_categories",
  "reorder_category_groups",
  "create_payee",
  "update_payee",
  "delete_payee",
  "merge_payees",
  "create_schedule",
  "update_schedule",
  "delete_schedule",
  "skip_schedule_date",
  "post_schedule_transaction",
  "undo_schedule_payment",
  "create_rule",
  "update_rule",
  "delete_rule",
  "create_tag",
  "delete_tag",
  "add_transaction_tag",
  "remove_transaction_tag",
  "create_report",
  "update_report",
  "delete_report",
  "update_dashboard",
  "update_exchange_rate",
  "update_setting",
  "create_note",
  "update_note",
  "delete_note",
  "list_notes",
] as const;

export type SyncCommandType = (typeof SYNC_COMMAND_TYPES)[number];
const SyncCommandTypeSchema = Schema.Literals(SYNC_COMMAND_TYPES);
export function isSyncCommandType<Value>(value: Value): value is Value & SyncCommandType {
  return Schema.is(SyncCommandTypeSchema)(value);
}

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------
export type AccountId = string & { readonly __brand: "AccountId" };
export type TransactionId = string & { readonly __brand: "TransactionId" };
export type CategoryId = string & { readonly __brand: "CategoryId" };
export type CategoryGroupId = string & { readonly __brand: "CategoryGroupId" };
export type PayeeId = string & { readonly __brand: "PayeeId" };
export type ScheduleId = string & { readonly __brand: "ScheduleId" };
export type RuleId = string & { readonly __brand: "RuleId" };
export type TagId = string & { readonly __brand: "TagId" };
export type ReportId = string & { readonly __brand: "ReportId" };
export type WidgetId = string & { readonly __brand: "WidgetId" };
export type EventId = string & { readonly __brand: "EventId" };
export type OpId = string & { readonly __brand: "OpId" };

export const AccountIdSchema = Schema.String.pipe(Schema.brand("AccountId"));
export const TransactionIdSchema = Schema.String.pipe(Schema.brand("TransactionId"));
export const CategoryIdSchema = Schema.String.pipe(Schema.brand("CategoryId"));
export const CategoryGroupIdSchema = Schema.String.pipe(Schema.brand("CategoryGroupId"));
export const PayeeIdSchema = Schema.String.pipe(Schema.brand("PayeeId"));
export const ScheduleIdSchema = Schema.String.pipe(Schema.brand("ScheduleId"));
export const RuleIdSchema = Schema.String.pipe(Schema.brand("RuleId"));
export const TagIdSchema = Schema.String.pipe(Schema.brand("TagId"));
export const ReportIdSchema = Schema.String.pipe(Schema.brand("ReportId"));
export const WidgetIdSchema = Schema.String.pipe(Schema.brand("WidgetId"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PREFIXES = [
  "acct",
  "txn",
  "cat",
  "cgrp",
  "pay",
  "sch",
  "rule",
  "tag",
  "rpt",
  "wgt",
  "nt",
  "flt",
] as const;

type PrefixToBrand = {
  acct: AccountId;
  txn: TransactionId;
  cat: CategoryId;
  cgrp: CategoryGroupId;
  pay: PayeeId;
  sch: ScheduleId;
  rule: RuleId;
  tag: TagId;
  rpt: ReportId;
  wgt: WidgetId;
  flt: string;
  nt: string;
};

export function createId<P extends (typeof PREFIXES)[number]>(prefix: P): PrefixToBrand[P] {
  // SAFETY: each fixed prefix is mapped to the corresponding opaque ID brand above.
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}` as PrefixToBrand[P];
}

/** Cast a known-valid string to a branded ID type. Use at trust boundaries (after validation). */
export function castId<T extends string>(id: string): T {
  // SAFETY: callers use this only after loading an ID from its owning persisted column.
  return id as T;
}

// ---------------------------------------------------------------------------
// CommandResult — shared return type for all command handlers
// ---------------------------------------------------------------------------
export interface CommandData {
  id?: string;
  count?: number;
  month?: number;
  budget?: object | null;
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: readonly string[];
  childIds?: string[];
  parentId?: string;
  targetId?: string;
  transactionId?: string;
  tagId?: string;
  key?: string;
  value?: string;
  nextDate?: string | null;
  completed?: boolean;
  recurrenceRules?: string;
  notes?: object[];
}

export type CommandResult = { ok: true; data: CommandData } | { ok: false; error: string };

export function nowIso(): string {
  return new Date().toISOString();
}

export function toMonthInt(monthKey: string): number {
  // "2026-04" → 202604
  const [y, m] = monthKey.split("-").map(Number);
  return y * 100 + m;
}

export function fromMonthInt(monthInt: number): string {
  // 202604 → "2026-04"
  const y = Math.floor(monthInt / 100);
  const m = monthInt % 100;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function budgetId(month: number, categoryId: string): string {
  return `${month}-${categoryId}`;
}

export function getCurrentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getCurrentMonthInt(): number {
  return toMonthInt(getCurrentMonthKey());
}

/** Format a local Date as YYYY-MM-DD without UTC shift. */
export function formatCalendarDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Inclusive calendar-month range for YYYY-MM keys.
 * Use `date >= start AND date <= end` (or `date < exclusiveEnd`).
 */
export interface MonthBoundaries {
  start: string;
  end: string;
  exclusiveEnd: string;
}

export function monthBoundaries(monthKey: string): MonthBoundaries {
  const [y, m] = monthKey.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const endDate = new Date(y, m, 0);
  const end = formatCalendarDate(endDate);
  const exclusiveEnd = formatCalendarDate(new Date(y, m, 1));
  return { start, end, exclusiveEnd };
}

/** Parse a YYYY-MM-DD calendar date as local components (no UTC midnight shift). */
export function parseCalendarDate(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function prevMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Envelope budget computed values
// ---------------------------------------------------------------------------
export interface CategoryBudgetRow {
  categoryId: CategoryId;
  categoryName: string;
  groupId: CategoryGroupId | null;
  groupName: string | null;
  budgeted: number;
  spent: number;
  leftover: number;
  leftoverPos: number;
  carryover: boolean;
}

export interface MonthBudgetSummary {
  month: number;
  monthKey: string;
  totalIncome: number;
  totalBudgeted: number;
  totalSpent: number;
  toBudget: number;
  buffered: number;
  categories: CategoryBudgetRow[];
}

// ---------------------------------------------------------------------------
// SyncTables — per-table typed records for snapshots
// ---------------------------------------------------------------------------
import type {
  Account,
  Transaction,
  Category,
  CategoryGroup,
  Payee,
  Schedule,
  Rule,
  Tag,
  TransactionTag,
  Budget,
  BudgetMonth,
  CustomReport,
  DashboardWidget,
  ExchangeRate,
  Setting,
  Note,
} from "../db/schema";

export type SyncTables = {
  accounts?: Record<string, Account>;
  transactions?: Record<string, Transaction>;
  categories?: Record<string, Category>;
  category_groups?: Record<string, CategoryGroup>;
  payees?: Record<string, Payee>;
  schedules?: Record<string, Schedule>;
  rules?: Record<string, Rule>;
  tags?: Record<string, Tag>;
  transaction_tags?: Record<string, TransactionTag>;
  budgets?: Record<string, Budget>;
  budget_months?: Record<string, BudgetMonth>;
  custom_reports?: Record<string, CustomReport>;
  dashboard_widgets?: Record<string, DashboardWidget>;
  exchange_rates?: Record<string, ExchangeRate>;
  settings?: Record<string, Setting>;
  notes?: Record<string, Note>;
};

// ---------------------------------------------------------------------------
// SyncSnapshot
// ---------------------------------------------------------------------------
export interface SyncSnapshot {
  serverSeq?: number;
  tables: SyncTables;
}
