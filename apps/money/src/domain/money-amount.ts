export type CurrencyCode = "USD" | "IDR";
export type NumberFormat = "comma-dot" | "dot-comma" | "space-dot";

export const NUMBER_FORMAT_SEPS = {
  "comma-dot": { thousands: ",", decimal: "." },
  "dot-comma": { thousands: ".", decimal: "," },
  "space-dot": { thousands: " ", decimal: "." },
} satisfies Record<NumberFormat, { thousands: string; decimal: string }>;

export function resolveNumberFormat(currency: CurrencyCode, preference?: string): NumberFormat {
  if (preference === "comma-dot" || preference === "dot-comma" || preference === "space-dot")
    return preference;
  return currency === "IDR" ? "dot-comma" : "comma-dot";
}

/** Amounts retain Money's integer storage: 100 units per dollar or rupiah. */
export function parseAmountInput(
  value: string,
  currency: CurrencyCode,
  numberFormat = resolveNumberFormat(currency),
): number {
  const separators = NUMBER_FORMAT_SEPS[numberFormat];
  let clean = value.trim().replace(/[\u00a0\u202f]/g, " ");
  const negative = clean.startsWith("-");
  if (negative) clean = clean.slice(1).trim();
  clean = clean.replace(currency === "IDR" ? /^(?:Rp\.?|IDR)\s*/i : /^(?:\$|USD)\s*/i, "");
  const parts = clean.split(separators.decimal);
  if (parts.length > 2) return NaN;
  const [wholePart, fraction = ""] = parts;
  const whole = currency === "USD" && wholePart === "" && parts.length === 2 ? "0" : wholePart;
  if (parts.length === 2 && !/^\d{1,2}$/.test(fraction)) return NaN;
  if (currency === "IDR" && /[1-9]/.test(fraction)) return NaN;
  const groups = whole.split(separators.thousands);
  if (groups.length === 1) {
    if (!/^\d+$/.test(whole)) return NaN;
  } else if (
    !/^\d{1,3}$/.test(groups[0]) ||
    groups.slice(1).some((group) => !/^\d{3}$/.test(group))
  ) {
    return NaN;
  }
  const amount = Number(groups.join("")) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount)) return NaN;
  return negative ? -amount : amount;
}

export function formatAmountInput(
  amount: number,
  currency: CurrencyCode,
  numberFormat = resolveNumberFormat(currency),
): string {
  const separators = NUMBER_FORMAT_SEPS[numberFormat];
  if (currency === "IDR") {
    return String(Math.round(amount / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, separators.thousands);
  }
  return (amount / 100).toFixed(2).replace(".", separators.decimal);
}
