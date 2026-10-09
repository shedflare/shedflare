import { describe, expect, test } from "vite-plus/test";
import { parseAmountInput, formatAmountInput, formatAmountTyping } from "./money-amount";
import { createFuzzRandom } from "../test/fuzz";

describe("rupiah amount entry", () => {
  test("plain and Indonesian grouped amounts have the same exact stored value", () => {
    for (const input of [
      "1250000",
      "1.250.000",
      "Rp1.250.000",
      "Rp 1.250.000",
      "IDR 1.250.000",
      "1.250.000,00",
    ])
      expect(parseAmountInput(input, "IDR")).toBe(125_000_000);
    expect(parseAmountInput("-Rp 2.500.000.000", "IDR")).toBe(-250_000_000_000);
    expect(parseAmountInput("0", "IDR")).toBe(0);
  });

  test("invalid grouping, fractional rupiah, and unsafe integers cannot silently save", () => {
    for (const input of [
      "",
      "Rp",
      "1.25.000",
      "1.250.00",
      "1250000garbage",
      "1e6",
      "1,50",
      "1.250.000,01",
      "90071992547410",
      "-",
      "1..000",
    ])
      expect(parseAmountInput(input, "IDR")).toBeNaN();
  });

  test("explicit number preferences apply to both entry and display", () => {
    expect(parseAmountInput("Rp1,250,000", "IDR", "comma-dot")).toBe(125_000_000);
    expect(formatAmountInput(125_000_000, "IDR", "space-dot")).toBe("1 250 000");
    expect(parseAmountInput("1\u00a0250\u00a0000", "IDR", "space-dot")).toBe(125_000_000);
    expect(parseAmountInput("$1,250.50", "USD")).toBe(125_050);
    expect(parseAmountInput(".50", "USD")).toBe(50);
    expect(parseAmountInput("1.250,50", "USD", "dot-comma")).toBe(125_050);
    expect(formatAmountInput(125_050, "USD", "dot-comma")).toBe("1250,50");
    expect(parseAmountInput("1.250.000", "USD")).toBeNaN();
  });

  test("large whole rupiah round-trip exactly across 3,000 values", () => {
    const random = createFuzzRandom(0x1d1234);
    for (let index = 0; index < 1_000; index++) {
      const amount = random.int(-1_000_000_000_000, 1_000_000_000_000) * 100;
      for (const format of ["comma-dot", "dot-comma", "space-dot"] as const)
        expect(parseAmountInput(formatAmountInput(amount, "IDR", format), "IDR", format)).toBe(
          amount,
        );
    }
  });
});

describe("amount typing", () => {
  test("rupiah keeps digits only and regroups thousands", () => {
    expect(formatAmountTyping("58000", "IDR")).toBe("58.000");
    expect(formatAmountTyping("58.0001", "IDR")).toBe("580.001");
    expect(formatAmountTyping("1a2b3,4", "IDR")).toBe("1.234");
    expect(formatAmountTyping("007", "IDR")).toBe("7");
    expect(parseAmountInput(formatAmountTyping("1250000", "IDR"), "IDR")).toBe(125_000_000);
  });

  test("dollars allow one decimal separator with up to two decimals", () => {
    expect(formatAmountTyping("1234", "USD")).toBe("1,234");
    expect(formatAmountTyping("1234.", "USD")).toBe("1,234.");
    expect(formatAmountTyping("1234.567", "USD")).toBe("1,234.56");
    expect(formatAmountTyping(".5", "USD")).toBe("0.5");
    expect(formatAmountTyping("12.3.4", "USD")).toBe("12.34");
    expect(formatAmountTyping("-$9x9", "USD")).toBe("99");
    expect(parseAmountInput(formatAmountTyping("1234.5", "USD"), "USD")).toBe(123_450);
  });
});
