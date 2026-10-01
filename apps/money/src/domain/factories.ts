import * as schema from "../db/schema";
import { createId, nowIso } from "./types";
import type { CategoryIcon } from "./category-icons";

// ---------------------------------------------------------------------------
// Factory functions produce validated row objects ready for DB insertion.
// They mirror Actual Budget's createXxx() functions but produce Drizzle rows.
// ---------------------------------------------------------------------------

export function createAccount(input: {
  name: string;
  offBudget?: boolean;
  balance?: number;
  sortOrder?: number;
}) {
  const now = nowIso();
  return {
    id: createId("acct"),
    name: input.name,
    offbudget: input.offBudget ?? false,
    closed: false,
    sortOrder: input.sortOrder ?? 0,
    balanceCurrent: input.balance ?? null,
    balanceAvailable: null,
    balanceLimit: null,
    mask: null,
    officialName: null,
    lastReconciled: null,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Account;
}

export function createCategory(input: {
  name: string;
  groupId: string | null;
  isIncome?: boolean;
  sortOrder?: number;
  icon?: CategoryIcon | null;
}) {
  const now = nowIso();
  return {
    id: createId("cat"),
    name: input.name,
    icon: input.icon ?? null,
    isIncome: input.isIncome ?? false,
    groupId: input.groupId,
    sortOrder: input.sortOrder ?? 0,
    hidden: false,
    goalDef: null,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Category;
}

export function createCategoryGroup(input: {
  name: string;
  isIncome?: boolean;
  sortOrder?: number;
}) {
  const now = nowIso();
  return {
    id: createId("cgrp"),
    name: input.name,
    isIncome: input.isIncome ?? false,
    sortOrder: input.sortOrder ?? 0,
    hidden: false,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.CategoryGroup;
}

interface TransactionInput {
  accountId: string;
  categoryId?: string | null;
  amount: number;
  payee?: string | null;
  notes?: string | null;
  date: string;
  cleared?: boolean;
  reconciled?: boolean;
  importedDescription?: string | null;
  startingBalanceFlag?: boolean;
  sortOrder?: number | null;
  isParent?: boolean;
  isChild?: boolean;
  parentId?: string | null;
  transferId?: string | null;
  scheduleId?: string | null;
}

export function createTransaction(input: TransactionInput & { id?: string }) {
  const now = nowIso();
  return {
    id: input.id ?? createId("txn"),
    accountId: input.accountId,
    categoryId: input.categoryId ?? null,
    amount: input.amount,
    payee: input.payee ?? null,
    notes: input.notes ?? null,
    date: input.date,
    cleared: input.cleared ?? true,
    reconciled: input.reconciled ?? false,
    importedDescription: input.importedDescription ?? null,
    startingBalanceFlag: input.startingBalanceFlag ?? false,
    sortOrder: input.sortOrder ?? null,
    isParent: input.isParent ?? false,
    isChild: input.isChild ?? false,
    parentId: input.parentId ?? null,
    transferId: input.transferId ?? null,
    scheduleId: input.scheduleId ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Transaction;
}

export function createPayee(input: { name: string }) {
  const now = nowIso();
  return {
    id: createId("pay"),
    name: input.name,
    transferAccountId: null,
    favorite: false,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Payee;
}

export function createSchedule(input: {
  recurrenceRules: string;
  name?: string | null;
  accountId?: string | null;
  payeeId?: string | null;
  categoryId?: string | null;
  amount?: number | null;
  startDate?: string | null;
  active?: boolean;
  completed?: boolean;
  postsTransaction?: boolean;
  customUpcomingLength?: number | null;
  nextDate?: string | null;
}) {
  const now = nowIso();
  return {
    id: createId("sch"),
    name: input.name ?? null,
    accountId: input.accountId ?? null,
    payeeId: input.payeeId ?? null,
    categoryId: input.categoryId ?? null,
    amount: input.amount ?? null,
    startDate: input.startDate ?? null,
    recurrenceRules: input.recurrenceRules,
    active: input.active ?? true,
    completed: input.completed ?? false,
    postsTransaction: input.postsTransaction ?? false,
    customUpcomingLength: input.customUpcomingLength ?? null,
    nextDate: input.nextDate ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Schedule;
}

export function createRule(input: {
  stage?: string;
  conditionsOp?: string;
  conditions: string;
  actions: string;
  active?: boolean;
}) {
  const now = nowIso();
  return {
    id: createId("rule"),
    stage: input.stage ?? "pre",
    conditionsOp: input.conditionsOp ?? "and",
    conditions: input.conditions,
    actions: input.actions,
    active: input.active ?? true,
    deleted: false,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Rule;
}

export function createTransactionTag(input: { transactionId: string; tagId: string }) {
  return {
    transactionId: input.transactionId,
    tagId: input.tagId,
  } satisfies schema.TransactionTag;
}

export function createTag(input: { name: string; color?: string }) {
  const now = nowIso();
  return {
    id: createId("tag"),
    name: input.name,
    color: input.color ?? null,
    createdAt: now,
  } satisfies schema.Tag;
}

export function createBudget(input: {
  month: number;
  categoryId: string;
  amount?: number;
  carryover?: boolean;
}) {
  const now = nowIso();
  return {
    id: `${input.month}-${input.categoryId}`,
    month: input.month,
    categoryId: input.categoryId,
    amount: input.amount ?? 0,
    carryover: input.carryover ?? false,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Budget;
}

export function createBudgetMonth(input: { monthKey: string; buffered?: number }) {
  const now = nowIso();
  return {
    id: input.monthKey,
    buffered: input.buffered ?? 0,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.BudgetMonth;
}

export function createCustomReport(input: {
  name?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  metadata?: string | null;
  conditions?: string | null;
  graphType?: string | null;
  mode?: string | null;
  groupBy?: string | null;
  interval?: string | null;
}) {
  const now = nowIso();
  return {
    id: createId("rpt"),
    name: input.name ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    dateStatic: false,
    dateRange: null,
    mode: input.mode ?? null,
    groupBy: input.groupBy ?? null,
    sortBy: "desc",
    interval: input.interval ?? null,
    balanceType: null,
    showEmpty: false,
    showOffbudget: false,
    showHidden: false,
    showUncategorized: false,
    trimIntervals: false,
    includeCurrent: true,
    graphType: input.graphType ?? null,
    conditions: input.conditions ?? "[]",
    conditionsOp: "and",
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.CustomReport;
}

export function createTransactionFilter(input: {
  name: string;
  conditions: string;
  conditionsOp?: string;
}) {
  const now = nowIso();
  return {
    id: createId("flt"),
    name: input.name,
    conditions: input.conditions,
    conditionsOp: input.conditionsOp ?? "and",
    createdAt: now,
    updatedAt: now,
  } satisfies schema.TransactionFilter;
}

export function createDashboardWidget(input: {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  meta?: string | null;
}) {
  const now = nowIso();
  return {
    id: createId("wgt"),
    type: input.type,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    meta: input.meta ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.DashboardWidget;
}

export function createNote(input: { noteableType: string; noteableId: string; body: string }) {
  const now = nowIso();
  return {
    id: createId("nt"),
    noteableType: input.noteableType,
    noteableId: input.noteableId,
    body: input.body,
    createdAt: now,
    updatedAt: now,
  } satisfies schema.Note;
}

export function updateNote(existing: schema.Note, body: string) {
  return {
    ...existing,
    body,
    updatedAt: nowIso(),
  } satisfies schema.Note;
}
