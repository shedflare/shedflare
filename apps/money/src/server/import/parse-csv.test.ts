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
