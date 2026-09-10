import { describe, expect, it } from "vitest";

import { formatBalanceAmount, formatMoneyAmount } from "./money";

describe("formatMoneyAmount", () => {
  it("keeps cents and preserves micro-yuan precision without floating point", () => {
    expect(formatMoneyAmount("0")).toBe("0.00");
    expect(formatMoneyAmount("10")).toBe("10.00");
    expect(formatMoneyAmount("19.980000")).toBe("19.98");
    expect(formatMoneyAmount("0.000001")).toBe("0.000001");
    expect(formatMoneyAmount("-1234.5")).toBe("-1,234.50");
  });
});

describe("formatBalanceAmount", () => {
  it("rounds balances to two decimal places without floating point drift", () => {
    expect(formatBalanceAmount("0.857381")).toBe("0.86");
    expect(formatBalanceAmount("19.984")).toBe("19.98");
    expect(formatBalanceAmount("19.985")).toBe("19.99");
    expect(formatBalanceAmount("1234.5")).toBe("1,234.50");
  });
});
