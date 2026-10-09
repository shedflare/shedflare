import * as Schema from "effect/Schema";

export const PayeeHistorySchema = Schema.Struct({
  payees: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      uses: Schema.Number,
      /** The category this payee is most often filed under, if any */
      categoryId: Schema.NullOr(Schema.String),
    }),
  ),
});
export type PayeeHistory = Schema.Schema.Type<typeof PayeeHistorySchema>;
export type PayeeHistoryEntry = PayeeHistory["payees"][number];

/** One `(payee, category)` group from the transactions table. */
export interface PayeeCategoryCount {
  payee: string;
  categoryId: string | null;
  uses: number;
  lastDate: string;
}

/** Collapses category groups into one entry per payee, most used and most recent first. */
export function payeeHistory(rows: readonly PayeeCategoryCount[]): PayeeHistoryEntry[] {
  const byName = new Map<
    string,
    { uses: number; lastDate: string; categoryId: string | null; categoryUses: number }
  >();
  for (const row of rows) {
    const entry = byName.get(row.payee) ?? {
      uses: 0,
      lastDate: "",
      categoryId: null,
      categoryUses: 0,
    };
    entry.uses += row.uses;
    if (row.lastDate > entry.lastDate) entry.lastDate = row.lastDate;
    if (row.categoryId && row.uses > entry.categoryUses) {
      entry.categoryId = row.categoryId;
      entry.categoryUses = row.uses;
    }
    byName.set(row.payee, entry);
  }
  return [...byName]
    .sort(
      ([nameA, a], [nameB, b]) =>
        b.uses - a.uses || b.lastDate.localeCompare(a.lastDate) || nameA.localeCompare(nameB),
    )
    .map(([name, entry]) => ({ name, uses: entry.uses, categoryId: entry.categoryId }));
}

/** Exact payee lookup, ignoring case and surrounding space. */
export function findPayee(
  payees: readonly PayeeHistoryEntry[],
  name: string,
): PayeeHistoryEntry | undefined {
  const needle = name.trim().toLocaleLowerCase();
  return needle ? payees.find((row) => row.name.toLocaleLowerCase() === needle) : undefined;
}

/**
 * Payees containing the typed text, keeping history order within each tier:
 * name prefix, then word prefix, then anywhere. The exact name is omitted.
 */
export function matchPayees(
  payees: readonly PayeeHistoryEntry[],
  query: string,
  limit = 6,
): PayeeHistoryEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const tiers: PayeeHistoryEntry[][] = [[], [], []];
  for (const row of payees) {
    const name = row.name.toLocaleLowerCase();
    if (name === needle) continue;
    const index = name.indexOf(needle);
    if (index === 0) tiers[0].push(row);
    else if (index > 0 && /[\s\-/&.(]/.test(name[index - 1])) tiers[1].push(row);
    else if (index > 0) tiers[2].push(row);
    if (tiers[0].length >= limit) break;
  }
  return tiers.flat().slice(0, limit);
}
