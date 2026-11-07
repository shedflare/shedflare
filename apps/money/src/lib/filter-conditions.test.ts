import { describe, expect, test } from "vite-plus/test";
import {
  amountPresets,
  type Condition,
  conditionParts,
  flipCondition,
  parseSavedConditions,
  putCondition,
  toggleListValue,
} from "./filter-conditions";

const names = new Map([
  ["food", "Food"],
  ["rent", "Rent"],
  ["fun", "Fun"],
]);
const format = {
  name: (_field: "category" | "account", id: string) => names.get(id),
  cents: (cents: number) => `$${cents / 100}`,
  date: (date: string) => date,
};

describe("toggleListValue", () => {
  test("adds, widens to oneOf, narrows back, and drops the condition", () => {
    let conditions: Condition[] = [{ field: "payee", op: "contains", value: "x" }];
    conditions = toggleListValue(conditions, "category", "food");
    expect(conditions[1]).toEqual({ field: "category", op: "is", value: "food" });
    conditions = toggleListValue(conditions, "category", "rent");
    expect(conditions[1]).toEqual({ field: "category", op: "oneOf", value: ["food", "rent"] });
    conditions = toggleListValue(conditions, "category", "food");
    expect(conditions[1]).toEqual({ field: "category", op: "is", value: "rent" });
    conditions = toggleListValue(conditions, "category", "rent");
    expect(conditions).toEqual([{ field: "payee", op: "contains", value: "x" }]);
  });

  test("leaves exclusions alone and adds a separate include", () => {
    const conditions: Condition[] = [{ field: "category", op: "isNot", value: "food" }];
    expect(toggleListValue(conditions, "category", "rent")).toEqual([
      conditions[0],
      { field: "category", op: "is", value: "rent" },
    ]);
  });
});

test("putCondition replaces at an index or appends", () => {
  const a: Condition = { field: "notes", op: "contains", value: "a" };
  const b: Condition = { field: "notes", op: "contains", value: "b" };
  expect(putCondition([a], b, 0)).toEqual([b]);
  expect(putCondition([a], b, null)).toEqual([a, b]);
});

test("amount presets store spending as negative amounts", () => {
  const [atLeast, atMost, received] = amountPresets(5000);
  expect(atLeast.condition).toEqual({ field: "amount", op: "lte", value: -5000 });
  expect(atMost.condition).toEqual({ field: "amount", op: "isbetween", value: -5000, value2: -1 });
  expect(received.condition).toEqual({ field: "amount", op: "gte", value: 5000 });
  expect(conditionParts(atLeast.condition, format)).toEqual({
    field: "Spent",
    op: "at least",
    value: "$50",
  });
  expect(flipCondition(atLeast.condition)).toEqual(atMost.condition);
  expect(flipCondition(atMost.condition)).toEqual(atLeast.condition);
});

test("chip parts show names instead of ids", () => {
  expect(conditionParts({ field: "category", op: "is", value: "food" }, format)).toEqual({
    field: "Category",
    op: "is",
    value: "Food",
  });
  expect(
    conditionParts({ field: "category", op: "oneOf", value: ["food", "rent", "fun"] }, format)
      .value,
  ).toBe("3 categories");
  expect(conditionParts({ field: "cleared", op: "is", value: false }, format).value).toBe("No");
});

test("flipCondition toggles negation and leaves multi-value picks alone", () => {
  expect(flipCondition({ field: "category", op: "is", value: "food" })).toEqual({
    field: "category",
    op: "isNot",
    value: "food",
  });
  expect(flipCondition({ field: "category", op: "oneOf", value: ["a", "b"] })).toBeNull();
  expect(flipCondition({ field: "cleared", op: "is", value: true })?.value).toBe(false);
});

test("parseSavedConditions rejects malformed JSON", () => {
  expect(parseSavedConditions("nope")).toEqual([]);
  expect(parseSavedConditions('[{"field":"payee","op":"contains","value":"a"}]')).toEqual([
    { field: "payee", op: "contains", value: "a" },
  ]);
});
