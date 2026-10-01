import { expect, test } from "vite-plus/test";
import { parseCsv } from "./parse-csv";

test("Indonesian bank amounts preserve every digit and debit/credit signs", () => {
  const result = parseCsv(
    "Tanggal;Keterangan;Debit;Credit\n01/10/2026;Rent;Rp 1.250.000,00;\n01/10/2026;Salary;;12.500.000\n01/10/2026;Coffee;35.000;",
  );
  expect(result.errors).toEqual([]);
  expect(result.rows.map((row) => row.amount)).toEqual([-125_000_000, 1_250_000_000, -3_500_000]);
});

test("USD, decimal comma, and parentheses remain valid while malformed values are rejected", () => {
  const result = parseCsv(
    "Date;Amount\n2026-10-01;1,234.56\n2026-10-01;1.234,56\n2026-10-01;($1,234.56)\n2026-10-01;1.25.000\n2026-10-01;Rp1.250.000oops",
  );
  expect(result.rows.map((row) => row.amount)).toEqual([123_456, 123_456, -123_456]);
  expect(result.errors).toHaveLength(2);
});

test("BOM, quoted headers, escaped quotes and multiline notes survive an export round trip", () => {
  const result = parseCsv(
    '\uFEFF"Date","Amount","Payee","Category","Notes","Account"\r\n2026-10-01,-1250000,"Toko ""Budi"", Jakarta","Food, drinks","First line\nSecond ""line""","Daily wallet"',
  );
  expect(result.errors).toEqual([]);
  expect(result.rows).toEqual([
    {
      date: "2026-10-01",
      amount: -125_000_000,
      payee: 'Toko "Budi", Jakarta',
      category: "Food, drinks",
      notes: 'First line\nSecond "line"',
      account: "Daily wallet",
      importedDescription: undefined,
    },
  ]);
});
test("column mapping and explicit American dates work; impossible dates and malformed CSV are rejected", () => {
  const mapping = { date: "When", amount: "Total", payee: "Shop" };
  expect(
    parseCsv("When;Total;Shop\n10/31/2026;125.50;Market", mapping, { dateFormat: "mdy" }).rows[0],
  ).toMatchObject({ date: "2026-10-31", amount: 12550, payee: "Market" });
  expect(parseCsv("Date,Amount\n2026-02-30,100").errors).toHaveLength(1);
  expect(parseCsv('Date,Amount,Notes\n2026-10-01,100,"unclosed').errors).toEqual([
    "Unclosed quoted field",
  ]);
  expect(parseCsv("Date,Amount\n2026-10-01,100,extra").errors).toHaveLength(1);
});
test("IDR rejects fractional rupiah, split columns reject ambiguous signs, and missing columns can be mapped", () => {
  expect(
    parseCsv("Date;Amount\n2026-10-01;1.250,50", undefined, { currency: "IDR" }).errors,
  ).toHaveLength(1);
  expect(parseCsv("Date;Debit;Credit\n2026-10-01;20;10").errors).toHaveLength(1);
  expect(parseCsv("When;Total\n2026-10-01;100").headers).toEqual(["When", "Total"]);
  expect(
    parseCsv("When;Total\n2026-10-01;100", { date: "When", amount: "Total" }).rows,
  ).toHaveLength(1);
});
