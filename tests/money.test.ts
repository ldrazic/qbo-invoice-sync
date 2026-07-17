import { describe, expect, it } from "vitest";
import { centsToDecimalString, decimalStringToCents } from "../src/models/money.js";

describe("money conversions", () => {
  it("round-trips cents through decimal strings", () => {
    expect(centsToDecimalString(12_345)).toBe("123.45");
    expect(centsToDecimalString(5)).toBe("0.05");
    expect(centsToDecimalString(0)).toBe("0.00");
    expect(decimalStringToCents("123.45")).toBe(12_345);
    expect(decimalStringToCents("0.05")).toBe(5);
    expect(decimalStringToCents("100")).toBe(10_000);
    expect(decimalStringToCents("7.5")).toBe(750);
  });

  it("handles the classic float trap without floating point math", () => {
    // 0.1 + 0.2 !== 0.3 in JS floats; integer cents make this a non-issue.
    expect(decimalStringToCents("0.10") + decimalStringToCents("0.20")).toBe(
      decimalStringToCents("0.30"),
    );
  });

  it("accepts numbers from provider JSON (QBO sends numbers)", () => {
    expect(decimalStringToCents(123.45)).toBe(12_345);
    expect(decimalStringToCents(0.1)).toBe(10);
  });

  it("rejects garbage", () => {
    expect(() => decimalStringToCents("12,34")).toThrow();
    expect(() => decimalStringToCents("abc")).toThrow();
    expect(() => centsToDecimalString(1.5)).toThrow();
  });
});
