import { describe, expect, test } from "vite-plus/test";
import { findPayee, matchPayees, payeeHistory } from "./payee-history";

describe("payee history", () => {
  test("ranks payees by use and keeps each payee's most common category", () => {
    const history = payeeHistory([
      { payee: "Alfamart", categoryId: "groceries", uses: 3, lastDate: "2026-10-01" },
      { payee: "Alfamart", categoryId: "household", uses: 1, lastDate: "2026-10-08" },
      { payee: "Alfamart", categoryId: null, uses: 1, lastDate: "2026-10-09" },
      { payee: "Burger King", categoryId: "eating-out", uses: 2, lastDate: "2026-10-07" },
      { payee: "Bakery", categoryId: null, uses: 2, lastDate: "2026-10-09" },
    ]);
    expect(history).toEqual([
      { name: "Alfamart", uses: 5, categoryId: "groceries" },
      { name: "Bakery", uses: 2, categoryId: null },
      { name: "Burger King", uses: 2, categoryId: "eating-out" },
    ]);
  });

  test("matches name prefixes before word prefixes before substrings, without the exact name", () => {
    const payees = ["Kopi Kenangan", "Kopi", "Toko Kopi", "Alfamart", "Starbucks Kopiko"].map(
      (name, uses) => ({ name, uses, categoryId: null }),
    );
    expect(matchPayees(payees, "kopi").map((row) => row.name)).toEqual([
      "Kopi Kenangan",
      "Toko Kopi",
      "Starbucks Kopiko",
    ]);
    expect(matchPayees(payees, "mart").map((row) => row.name)).toEqual(["Alfamart"]);
    expect(matchPayees(payees, "  ")).toEqual([]);
    expect(matchPayees(payees, "o", 2)).toHaveLength(2);
  });

  test("finds a payee ignoring case and surrounding space", () => {
    const payees = [{ name: "SeIndonesia", uses: 1, categoryId: "food" }];
    expect(findPayee(payees, " seindonesia ")?.categoryId).toBe("food");
    expect(findPayee(payees, "seindo")).toBeUndefined();
  });
});
