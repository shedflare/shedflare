import * as Schema from "effect/Schema";

export const FIELD_NAMES = [
  "category",
  "account",
  "payee",
  "amount",
  "date",
  "notes",
  "cleared",
  "reconciled",
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export type CondOp =
  | "is"
  | "isNot"
  | "contains"
  | "doesNotContain"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isbetween"
  | "oneOf";

export interface Condition {
  field: FieldName;
  op: CondOp;
  value: string | number | boolean | null | string[];
  value2?: string | number | boolean | null | string[];
}

export const FieldNameSchema = Schema.Literals(FIELD_NAMES);
const CondOpSchema = Schema.Literals([
  "is",
  "isNot",
  "contains",
  "doesNotContain",
  "gt",
  "gte",
  "lt",
  "lte",
  "isbetween",
  "oneOf",
]);
const ConditionValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.mutable(Schema.Array(Schema.String)),
]);
const ConditionSchema = Schema.Struct({
  field: FieldNameSchema,
  op: CondOpSchema,
  value: ConditionValueSchema,
  value2: Schema.optional(ConditionValueSchema),
});

function copyValue(raw: (typeof ConditionValueSchema)["Type"]): Condition["value"] {
  return Array.isArray(raw) ? [...raw] : raw;
}

/** Decodes a saved filter's JSON conditions; malformed input yields no conditions. */
export function parseSavedConditions(json: string): Condition[] {
  try {
    return Schema.decodeUnknownSync(Schema.Array(ConditionSchema))(JSON.parse(json)).map(
      ({ field, op, value, value2 }): Condition => {
        return value2 === undefined
          ? { field, op, value: copyValue(value) }
          : { field, op, value: copyValue(value), value2: copyValue(value2) };
      },
    );
  } catch {
    return [];
  }
}

export const FIELD_LABELS = {
  category: "Category",
  account: "Account",
  payee: "Payee",
  amount: "Amount",
  date: "Date",
  notes: "Notes",
  cleared: "Cleared",
  reconciled: "Reconciled",
} satisfies Record<FieldName, string>;

/** Fields whose values are picked from a list of ids. */
export type ListField = "category" | "account";

export function isListField(field: FieldName): field is ListField {
  return field === "category" || field === "account";
}

/** Ids selected by an include condition (`is` / `oneOf`) on a list field. */
export function selectedIds(condition: Condition | undefined): string[] {
  if (!condition || (condition.op !== "is" && condition.op !== "oneOf")) return [];
  if (Array.isArray(condition.value)) return condition.value;
  return condition.value === null ? [] : [String(condition.value)];
}

/** Index of the include condition a list pick edits, or -1 when a new one is needed. */
export function listConditionIndex(conditions: readonly Condition[], field: ListField): number {
  return conditions.findIndex(
    (condition) => condition.field === field && (condition.op === "is" || condition.op === "oneOf"),
  );
}

/**
 * Adds or removes one id from a field's include condition: one id is `is`, several are `oneOf`,
 * and removing the last id drops the condition.
 */
export function toggleListValue(
  conditions: readonly Condition[],
  field: ListField,
  id: string,
): Condition[] {
  const index = listConditionIndex(conditions, field);
  const current = selectedIds(conditions[index]);
  const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
  const condition: Condition | null =
    next.length === 0
      ? null
      : next.length === 1
        ? { field, op: "is", value: next[0] }
        : { field, op: "oneOf", value: next };
  if (index === -1) return condition ? [...conditions, condition] : [...conditions];
  return conditions.flatMap((row, at) => (at !== index ? [row] : condition ? [condition] : []));
}

/** Replaces the condition at `index`, or appends when `index` is null. */
export function putCondition(
  conditions: readonly Condition[],
  condition: Condition,
  index: number | null,
): Condition[] {
  if (index === null || index >= conditions.length) return [...conditions, condition];
  return conditions.map((row, at) => (at === index ? condition : row));
}

/** Amount conditions are stored signed (spending is negative); these presets hide that. */
export function amountPresets(cents: number) {
  const size = Math.abs(cents);
  return [
    { label: "Spent at least", condition: { field: "amount", op: "lte", value: -size } },
    {
      label: "Spent at most",
      condition: { field: "amount", op: "isbetween", value: -size, value2: -1 },
    },
    { label: "Received at least", condition: { field: "amount", op: "gte", value: size } },
  ] satisfies { label: string; condition: Condition }[];
}

/** The opposite condition when a chip's operator is clicked, or null when it has none. */
export function flipCondition(condition: Condition): Condition | null {
  const { field, op, value, value2 } = condition;
  if (field === "cleared" || field === "reconciled") return { field, op: "is", value: !value };
  if (field === "amount") {
    const amount = Number(value);
    if (op === "lte" && amount < 0) return { field, op: "isbetween", value: amount, value2: -1 };
    if (op === "isbetween" && amount < 0 && value2 === -1) return { field, op: "lte", value };
    return null;
  }
  if (field === "date" && op === "gte") return { field, op: "lte", value };
  if (field === "date" && op === "lte") return { field, op: "gte", value };
  if (op === "is" && !Array.isArray(value)) return { field, op: "isNot", value };
  if (op === "isNot") return { field, op: "is", value };
  if (op === "contains") return { field, op: "doesNotContain", value };
  if (op === "doesNotContain") return { field, op: "contains", value };
  return null;
}

const OP_LABELS = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  doesNotContain: "does not contain",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  isbetween: "between",
  oneOf: "is any of",
} satisfies Record<CondOp, string>;

export type ConditionFormatters = {
  name: (field: ListField, id: string) => string | undefined;
  cents: (cents: number) => string;
  date: (date: string) => string;
};

/** The three chip segments: field, operator, and value. */
export type ConditionParts = { field: string; op: string; value: string };

function dateOpLabel(op: CondOp): string {
  if (op === "gte") return "on or after";
  if (op === "lte") return "on or before";
  return OP_LABELS[op];
}

export function conditionParts(condition: Condition, format: ConditionFormatters): ConditionParts {
  const { field, op, value, value2 } = condition;
  let parts: ConditionParts;
  if (isListField(field)) {
    const ids = Array.isArray(value) ? value : [String(value ?? "")];
    const names = ids.map((id) => format.name(field, id) ?? "Unknown");
    const plural = field === "category" ? "categories" : "accounts";
    parts = {
      field: FIELD_LABELS[field],
      op: OP_LABELS[op],
      value: names.length > 2 ? `${names.length} ${plural}` : names.join(", "),
    };
  } else if (field === "amount") {
    const amount = Number(value);
    if (op === "lte" && amount < 0) {
      parts = { field: "Spent", op: "at least", value: format.cents(-amount) };
    } else if (op === "isbetween" && amount < 0 && value2 === -1) {
      parts = { field: "Spent", op: "at most", value: format.cents(-amount) };
    } else if (op === "gte" && amount >= 0) {
      parts = { field: "Received", op: "at least", value: format.cents(amount) };
    } else {
      parts = {
        field: "Amount",
        op: OP_LABELS[op],
        value:
          op === "isbetween"
            ? `${format.cents(amount)} – ${format.cents(Number(value2))}`
            : format.cents(amount),
      };
    }
  } else if (field === "date") {
    parts = {
      field: "Date",
      op: dateOpLabel(op),
      value:
        op === "isbetween"
          ? `${format.date(String(value))} – ${format.date(String(value2))}`
          : format.date(String(value)),
    };
  } else if (field === "cleared" || field === "reconciled") {
    parts = { field: FIELD_LABELS[field], op: "is", value: value ? "Yes" : "No" };
  } else {
    parts = { field: FIELD_LABELS[field], op: OP_LABELS[op], value: `“${String(value ?? "")}”` };
  }
  return parts;
}
