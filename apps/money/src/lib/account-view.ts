/** Compute ledger balances in chronological order, then return newest entries first. */
export function accountLedger<
  Row extends { date: string; amount: number; isChild?: boolean; createdAt?: string },
>(rows: readonly Row[], openingBalance: number): Array<Row & { balance: number }> {
  const chronological = rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        a.row.date.localeCompare(b.row.date) ||
        (a.row.createdAt ?? "").localeCompare(b.row.createdAt ?? "") ||
        b.index - a.index,
    );
  let balance = openingBalance;
  return chronological
    .map(({ row }) => {
      if (!row.isChild) balance += row.amount;
      return { ...row, balance };
    })
    .reverse();
}
