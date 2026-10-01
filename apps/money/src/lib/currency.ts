import { createMemo } from "solid-js";
import { settingsCollection } from "./settings-store";

import {
  NUMBER_FORMAT_SEPS,
  resolveNumberFormat,
  parseAmountInput,
  formatAmountInput,
  type CurrencyCode,
  type NumberFormat,
} from "../domain/money-amount";
export type { CurrencyCode, NumberFormat } from "../domain/money-amount";

function getSettingValue(key: string): string | undefined {
  const setting = settingsCollection.state.get(key);
  return setting?.value;
}

function formatWithSeparators(
  value: number,
  decimalPlaces: number,
  thousandsSep: string,
  decimalSep: string,
): string {
  const fixed = value.toFixed(decimalPlaces);
  const [intPart, fracPart] = fixed.split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep);
  return fracPart ? `${withThousands}${decimalSep}${fracPart}` : withThousands;
}

export function formatCentsValue(
  cents: number,
  currency: CurrencyCode,
  numberFormat: NumberFormat = resolveNumberFormat(currency),
): string {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  const seps = NUMBER_FORMAT_SEPS[numberFormat];
  if (currency === "IDR") {
    const formatted = formatWithSeparators(Math.round(abs / 100), 0, seps.thousands, seps.decimal);
    return `${sign}Rp${formatted}`;
  }
  const formatted = formatWithSeparators(abs / 100, 2, seps.thousands, seps.decimal);
  return `${sign}$${formatted}`;
}

export function useCurrency() {
  return createMemo(() => {
    const cur = getSettingValue("display_currency") === "IDR" ? "IDR" : "USD";
    const nf = resolveNumberFormat(cur, getSettingValue("number_format"));

    return {
      code: cur,
      numberFormat: nf,
      formatCents: (cents: number): string => formatCentsValue(cents, cur, nf),
      formatCentsInput: (cents: number): string => formatAmountInput(cents, cur, nf),
      parseInput: (value: string): number => parseAmountInput(value, cur, nf),
      inputMode: cur === "IDR" ? ("numeric" as const) : ("decimal" as const),
      symbol: cur === "IDR" ? "Rp" : "$",
      locale: cur === "IDR" ? "id-ID" : "en-US",
    } as const;
  });
}
