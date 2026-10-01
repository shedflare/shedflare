import type { Transaction, Account, Category } from "../db/schema";
type ExportRow = Pick<Transaction, "date" | "amount" | "payee" | "notes"> & {
  category: Category["name"] | null;
  account: Account["name"] | null;
};
export function transactionCsv(rows: readonly ExportRow[]): string {
  const quote = (value: string | null) => `"${(value ?? "").replaceAll('"', '""')}"`;
  return (
    "Date,Amount,Payee,Category,Notes,Account\n" +
    rows
      .map((row) =>
        [
          row.date,
          String(row.amount / 100),
          quote(row.payee),
          quote(row.category),
          quote(row.notes),
          quote(row.account),
        ].join(","),
      )
      .join("\n")
  );
}
