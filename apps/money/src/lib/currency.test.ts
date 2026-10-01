import { describe, expect, test } from "vite-plus/test";
import { formatCentsValue } from "./currency";
import { formatChartAmount, formatChartTooltip } from "../charts/types";
import { createRoot } from "solid-js";
import { useCurrency } from "./currency";
import { setSetting } from "./settings-store";

describe("formatCentsValue", () => {
  test("USD formats with 2 decimals and a $ sign", () => {
    expect(formatCentsValue(123_456, "USD")).toBe("$1,234.56");
    expect(formatCentsValue(100, "USD")).toBe("$1.00");
    expect(formatCentsValue(0, "USD")).toBe("$0.00");
  });

  test("IDR formats with 0 decimals and an Rp prefix", () => {
    expect(formatCentsValue(123_456, "IDR")).toBe("Rp1.235");
    expect(formatCentsValue(100, "IDR")).toBe("Rp1");
    expect(formatCentsValue(0, "IDR")).toBe("Rp0");
  });

  test("negative values get a leading minus sign", () => {
    expect(formatCentsValue(-123_456, "USD")).toBe("-$1,234.56");
    expect(formatCentsValue(-123_456, "IDR")).toBe("-Rp1.235");
  });

  test("thousands separators differ by number format", () => {
    expect(formatCentsValue(1_234_567_89, "USD", "comma-dot")).toBe("$1,234,567.89");
    expect(formatCentsValue(1_234_567_89, "USD", "dot-comma")).toBe("$1.234.567,89");
    expect(formatCentsValue(1_234_567_89, "USD", "space-dot")).toBe("$1 234 567.89");
  });

  test("does not crash on huge values", () => {
    expect(formatCentsValue(1_000_000_000_00, "USD")).toBe("$1,000,000,000.00");
  });

  test("chart formatters can use the selected display currency", () => {
    const formatIdr = (cents: number) => formatCentsValue(cents, "IDR");

    expect(formatChartAmount(123_456, formatIdr)).toBe("Rp1.235");
    expect(formatChartTooltip(-123_456, formatIdr)).toBe("-Rp1.235");
  });

  test("currency defaults react to persisted settings and preserve explicit format choices", () => {
    setSetting("display_currency", "IDR");
    setSetting("number_format", "auto");
    createRoot((dispose) => {
      const format = useCurrency();
      try {
        setSetting("display_currency", "IDR");
        expect(format().formatCents(125_000_000)).toBe("Rp1.250.000");
        expect(format().formatCentsInput(125_000_000)).toBe("1.250.000");
        expect(format().parseInput("1.250.000")).toBe(125_000_000);
        setSetting("number_format", "comma-dot");
        expect(format().formatCents(125_000_000)).toBe("Rp1,250,000");
        setSetting("number_format", "auto");
        setSetting("display_currency", "USD");
        expect(format().formatCents(125_000_000)).toBe("$1,250,000.00");
      } finally {
        dispose();
        setSetting("display_currency", "USD");
        setSetting("number_format", "auto");
      }
    });
  });
});
