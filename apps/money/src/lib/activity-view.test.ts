import { describe, expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CategoryIdSchema, AccountIdSchema, TransactionIdSchema } from "../domain/types";
import { activityEntries, activityTotals, filterActivity } from "./activity-view";
import type { TransactionsResponse } from "../domain/schemas-client";

type Transaction = TransactionsResponse["transactions"][number];
function transaction(id: string, fields: Partial<Transaction> = {}): Transaction {
  return {
    id: Schema.decodeUnknownSync(TransactionIdSchema)(id),
    accountId: Schema.decodeUnknownSync(AccountIdSchema)("acc_daily"),
    accountName: "Everyday",
    date: "2026-10-01",
    amount: -100,
    categoryId: null,
    categoryName: null,
    payee: null,
    notes: null,
    cleared: true,
    reconciled: false,
    importedDescription: null,
    startingBalanceFlag: false,
    sortOrder: null,
    isParent: false,
    isChild: false,
    parentId: null,
    transferId: null,
    scheduleId: null,
    createdAt: "",
    updatedAt: "",
    ...fields,
  };
}
const parent = transaction("parent", { isParent: true, amount: -300 });
const children = [
  transaction("child1", {
    isChild: true,
    parentId: parent.id,
    categoryId: Schema.decodeUnknownSync(CategoryIdSchema)("cat_food"),
    categoryName: "Groceries",
    notes: "Eggs",
    amount: -200,
  }),
  transaction("child2", { isChild: true, parentId: parent.id, amount: -100 }),
];

describe("everyday activity", () => {
  test("filters by month and searches payee, category, account and notes", () => {
    const rows = [
      transaction("one", { payee: "Market", notes: "Fruit", categoryName: "Groceries" }),
      transaction("two", { date: "2026-09-30" }),
    ];
    for (const query of ["market", "fruit", "groceries", "everyday"])
      expect(filterActivity(rows, { month: "2026-10", query }).map((row) => row.id)).toEqual([
        "one",
      ]);
    expect(filterActivity(rows, { month: null, query: "" })).toHaveLength(2);
  });
  test("matches split children while showing the parent once and never double-counting money", () => {
    const rows = [parent, ...children];
    expect(activityEntries(rows).map((row) => row.id)).toEqual(["parent"]);
    expect(activityTotals(rows, false)).toEqual({ expense: 300, income: 0 });
    const filtered = filterActivity(rows, {
      month: "2026-10",
      category: "cat_food",
      query: "Eggs",
    });
    expect(filtered.map((row) => row.id)).toEqual(["parent", "child1"]);
    expect(activityEntries(filtered).map((row) => row.id)).toEqual(["parent"]);
    expect(activityTotals(filtered, true)).toEqual({ expense: 200, income: 0 });
    expect(activityEntries(children).map((row) => row.id)).toEqual(["child1", "child2"]);
  });
  test("transfers and starting balances do not become income, expenses, or uncategorized errands", () => {
    const rows = [
      transaction("transfer", {
        transferId: Schema.decodeUnknownSync(TransactionIdSchema)("peer"),
        amount: -400,
      }),
      transaction("opening", { startingBalanceFlag: true, amount: 500 }),
      transaction("income", {
        amount: 1000,
        categoryId: Schema.decodeUnknownSync(CategoryIdSchema)("salary"),
      }),
      transaction("uncategorized", { amount: -100 }),
    ];
    expect(activityTotals(rows, false)).toEqual({ income: 1000, expense: 100 });
    expect(
      filterActivity(rows, { month: null, view: "uncategorized", query: "" }).map((row) => row.id),
    ).toEqual(["uncategorized"]);
  });
});
