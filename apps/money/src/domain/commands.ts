import * as Schema from "effect/Schema";
import { SetupInputSchema } from "./setup";
import { CategoryIconSchema } from "./category-icons";
import {
  NullableString,
  TransactionInput,
  ScheduleInput,
  RuleInput,
  CustomReportInput,
  TransactionFilterInput,
  ParsedTransaction,
} from "./schemas";

// ---------------------------------------------------------------------------
// Each command is defined as an Effect/Schema struct.
// The CommandPayloadMap maps command type → payload schema.
// ---------------------------------------------------------------------------

// Effect Schema validators for each command type (used for validation in command handlers)
export const CommandPayloadSchemas = {
  setup_money: SetupInputSchema,
  create_account: Schema.Struct({
    name: Schema.String,
    offBudget: Schema.optional(Schema.Boolean),
    balance: Schema.optional(Schema.Number),
  }),

  update_account: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    offBudget: Schema.optional(Schema.Boolean),
    lastReconciled: Schema.optional(Schema.NullOr(Schema.String)),
  }),

  delete_account: Schema.Struct({
    id: Schema.String,
  }),

  close_account: Schema.Struct({
    id: Schema.String,
    transferAccountId: Schema.optional(NullableString),
  }),

  reopen_account: Schema.Struct({
    id: Schema.String,
  }),

  reorder_accounts: Schema.Struct({
    ids: Schema.Array(Schema.String),
  }),

  create_transaction: Schema.Struct({
    row: TransactionInput,
  }),

  create_account_transfer: Schema.Struct({
    fromAccountId: Schema.String,
    toAccountId: Schema.String,
    amount: Schema.Number,
    date: Schema.String,
    notes: Schema.optional(NullableString),
    fromPayee: Schema.optional(NullableString),
    toPayee: Schema.optional(NullableString),
    fromNotes: Schema.optional(NullableString),
    toNotes: Schema.optional(NullableString),
    fromCleared: Schema.optional(Schema.Boolean),
    toCleared: Schema.optional(Schema.Boolean),
  }),

  delete_account_transfer: Schema.Struct({ id: Schema.String }),

  reconcile_account: Schema.Struct({
    accountId: Schema.String,
    expectedBalance: Schema.Number,
    statementBalance: Schema.Number,
  }),

  update_transaction: Schema.Struct({
    id: Schema.String,
    fields: Schema.Struct({
      accountId: Schema.optional(Schema.String),
      categoryId: Schema.optional(NullableString),
      amount: Schema.optional(Schema.Number),
      payee: Schema.optional(NullableString),
      notes: Schema.optional(NullableString),
      date: Schema.optional(Schema.String),
      cleared: Schema.optional(Schema.Boolean),
      reconciled: Schema.optional(Schema.Boolean),
      importedDescription: Schema.optional(Schema.String),
      sortOrder: Schema.optional(Schema.Number),
    }),
  }),

  delete_transaction: Schema.Struct({
    id: Schema.String,
  }),

  split_transaction: Schema.Struct({
    parentId: Schema.String,
    children: Schema.Array(TransactionInput),
  }),

  import_transactions: Schema.Struct({
    accountId: Schema.String,
    transactions: Schema.Array(ParsedTransaction),
    isPreview: Schema.optional(Schema.Boolean),
    requestId: Schema.optional(Schema.String),
    skipDuplicates: Schema.optional(Schema.Boolean),
  }),

  undo_transaction_import: Schema.Struct({ id: Schema.String }),

  set_budget_amount: Schema.Struct({
    month: Schema.Number,
    categoryId: Schema.String,
    amount: Schema.Number,
  }),

  allocate_budget: Schema.Struct({
    month: Schema.String,
    allocations: Schema.Array(Schema.Struct({ categoryId: Schema.String, amount: Schema.Number })),
  }),

  set_budget_plan: Schema.Struct({
    month: Schema.String,
    assignments: Schema.Array(Schema.Struct({ categoryId: Schema.String, amount: Schema.Number })),
  }),

  set_budget_carryover: Schema.Struct({
    month: Schema.Number,
    categoryId: Schema.String,
    carryover: Schema.Boolean,
  }),

  set_buffer: Schema.Struct({
    month: Schema.String,
    amount: Schema.Number,
  }),

  copy_previous_month: Schema.Struct({
    month: Schema.String,
  }),

  set_3month_avg: Schema.Struct({
    month: Schema.String,
  }),

  set_nmonth_avg: Schema.Struct({
    month: Schema.String,
    months: Schema.Number,
  }),

  set_zero: Schema.Struct({
    month: Schema.String,
  }),

  apply_goal_templates: Schema.Struct({
    month: Schema.String,
  }),

  cover_overspending: Schema.Struct({
    month: Schema.String,
    from: Schema.String,
    to: Schema.String,
    amount: Schema.optional(Schema.Number),
  }),

  transfer_budget: Schema.Struct({
    month: Schema.String,
    from: Schema.String,
    to: Schema.String,
    amount: Schema.Number,
  }),

  hold_for_next_month: Schema.Struct({
    month: Schema.String,
    amount: Schema.Number,
  }),

  create_category: Schema.Struct({
    name: Schema.String,
    groupId: NullableString,
    isIncome: Schema.optional(Schema.Boolean),
    icon: Schema.optional(Schema.NullOr(CategoryIconSchema)),
  }),

  update_category: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    hidden: Schema.optional(Schema.Boolean),
    groupId: Schema.optional(NullableString),
    goalDef: Schema.optional(NullableString),
    icon: Schema.optional(Schema.NullOr(CategoryIconSchema)),
  }),

  delete_category: Schema.Struct({
    id: Schema.String,
    transferToId: Schema.optional(NullableString),
  }),

  create_category_group: Schema.Struct({
    name: Schema.String,
    isIncome: Schema.optional(Schema.Boolean),
  }),

  delete_category_group: Schema.Struct({
    id: Schema.String,
    transferToGroupId: Schema.optional(NullableString),
  }),

  update_category_group: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    hidden: Schema.optional(Schema.Boolean),
    isIncome: Schema.optional(Schema.Boolean),
  }),

  reorder_category_groups: Schema.Struct({ ids: Schema.Array(Schema.String) }),

  reorder_categories: Schema.Struct({
    ids: Schema.Array(Schema.String),
  }),

  create_payee: Schema.Struct({
    name: Schema.String,
  }),

  update_payee: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    favorite: Schema.optional(Schema.Boolean),
  }),

  delete_payee: Schema.Struct({
    id: Schema.String,
  }),

  merge_payees: Schema.Struct({
    targetId: Schema.String,
    sourceIds: Schema.Array(Schema.String),
  }),

  create_schedule: Schema.Struct({
    schedule: Schema.Struct({
      ...ScheduleInput.fields,
      recurrenceRules: Schema.String,
    }),
  }),

  update_schedule: Schema.Struct({
    id: Schema.String,
    fields: Schema.Struct({
      ...ScheduleInput.fields,
      recurrenceRules: Schema.optional(Schema.String),
    }),
  }),

  delete_schedule: Schema.Struct({
    id: Schema.String,
  }),

  skip_schedule_date: Schema.Struct({
    id: Schema.String,
  }),

  post_schedule_transaction: Schema.Struct({
    scheduleId: Schema.String,
  }),

  undo_schedule_payment: Schema.Struct({
    scheduleId: Schema.String,
    transactionId: Schema.String,
    nextDate: NullableString,
    completed: Schema.Boolean,
    recurrenceRules: Schema.String,
  }),

  create_rule: Schema.Struct({
    rule: RuleInput,
  }),

  update_rule: Schema.Struct({
    id: Schema.String,
    fields: RuleInput,
  }),

  delete_rule: Schema.Struct({
    id: Schema.String,
  }),

  create_tag: Schema.Struct({
    name: Schema.String,
    color: Schema.optional(Schema.String),
  }),

  delete_tag: Schema.Struct({
    id: Schema.String,
  }),

  add_transaction_tag: Schema.Struct({
    transactionId: Schema.String,
    tagId: Schema.String,
  }),

  remove_transaction_tag: Schema.Struct({
    transactionId: Schema.String,
    tagId: Schema.String,
  }),

  create_report: Schema.Struct({
    report: CustomReportInput,
  }),

  update_report: Schema.Struct({
    id: Schema.String,
    fields: CustomReportInput,
  }),

  delete_report: Schema.Struct({
    id: Schema.String,
  }),

  create_filter: Schema.Struct({
    filter: TransactionFilterInput,
  }),

  update_filter: Schema.Struct({
    id: Schema.String,
    fields: TransactionFilterInput,
  }),

  delete_filter: Schema.Struct({
    id: Schema.String,
  }),

  update_dashboard: Schema.Struct({
    widgets: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
        meta: Schema.optional(NullableString),
      }),
    ),
  }),

  update_exchange_rate: Schema.Struct({
    usdToIdr: Schema.Number,
  }),

  update_setting: Schema.Struct({
    key: Schema.String,
    value: Schema.String,
  }),

  create_note: Schema.Struct({
    noteableType: Schema.String,
    noteableId: Schema.String,
    body: Schema.String,
  }),

  update_note: Schema.Struct({
    id: Schema.String,
    noteableType: Schema.String,
    noteableId: Schema.String,
    body: Schema.String,
  }),

  delete_note: Schema.Struct({
    id: Schema.String,
    noteableType: Schema.String,
    noteableId: Schema.String,
  }),

  list_notes: Schema.Struct({
    noteableType: Schema.String,
  }),
} as const;

// ---------------------------------------------------------------------------
// Typed command payload maps (derived from Effect schemas — single source)
// ---------------------------------------------------------------------------
export type CommandPayloadMap = {
  [K in keyof typeof CommandPayloadSchemas]: Schema.Schema.Type<(typeof CommandPayloadSchemas)[K]>;
};

export type SyncCommandPayloadMap = {
  [K in keyof CommandPayloadMap]: CommandPayloadMap[K];
};

export type CommandInvocation = {
  [K in keyof CommandPayloadMap]: { commandType: K; payload: CommandPayloadMap[K] };
}[keyof CommandPayloadMap];

/** Decode and validate a command payload at runtime. Throws on invalid input. */
export function decodeCommand<K extends keyof typeof CommandPayloadSchemas, Input>(
  commandType: K,
  input: Input,
): CommandPayloadMap[K] {
  const decoded = Schema.decodeUnknownSync(CommandPayloadSchemas[commandType])(input);
  // SAFETY: commandType selects the same schema used to define CommandPayloadMap[K].
  return decoded as CommandPayloadMap[K];
}

export function decodeCommandInvocation<Input>(
  commandType: keyof CommandPayloadMap,
  input: Input,
): CommandInvocation {
  const payload = decodeCommand(commandType, input);
  // SAFETY: decodeCommand uses the schema selected by commandType, preserving the invocation pair.
  return { commandType, payload } as CommandInvocation;
}
