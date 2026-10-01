import * as Schema from "effect/Schema";
import { CategoryIconSchema } from "./category-icons";

export const SetupCategorySchema = Schema.Struct({
  name: Schema.String,
  icon: Schema.NullOr(CategoryIconSchema),
  isIncome: Schema.Boolean,
});
export type SetupCategory = Schema.Schema.Type<typeof SetupCategorySchema>;
export const SetupInputSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("complete"),
    requestId: Schema.String,
    currency: Schema.Literals(["USD", "IDR"]),
    account: Schema.Struct({ name: Schema.String, balance: Schema.Number }),
    categories: Schema.Array(SetupCategorySchema),
  }),
  Schema.Struct({
    mode: Schema.Literal("skip"),
    requestId: Schema.String,
    currency: Schema.Literals(["USD", "IDR"]),
  }),
]);
export const SetupStateSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("complete"),
    requestId: Schema.String,
    fingerprint: Schema.String,
    accountId: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("skipped"),
    requestId: Schema.String,
    fingerprint: Schema.String,
  }),
]);
export function readSetupState(value: string | null | undefined) {
  if (!value) return null;
  try {
    return Schema.decodeUnknownSync(SetupStateSchema)(JSON.parse(value));
  } catch {
    return null;
  }
}
export const STARTER_CATEGORIES: readonly SetupCategory[] = [
  { name: "Groceries", icon: "basket", isIncome: false },
  { name: "Eating out", icon: "utensils", isIncome: false },
  { name: "Transport", icon: "bus", isIncome: false },
  { name: "Home", icon: "home", isIncome: false },
  { name: "Bills", icon: "bolt", isIncome: false },
  { name: "Income", icon: "wallet", isIncome: true },
];
