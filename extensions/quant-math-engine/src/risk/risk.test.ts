import { describe, expect, it } from "vitest";
import { computeDrawdown } from "./drawdown.js";
import { kellyFraction } from "./kelly.js";
import { computeMaxPositionSize } from "./position-size.js";
import { parametricVaR } from "./var.js";

describe("kellyFraction", () => {
  it("returns ≈ 0.50 for 70% win rate, 1.5% avg win, 1.0% avg loss", () => {
    // f = (0.7 × 0.015 - 0.3 × 0.010) / 0.015 = (0.0105 - 0.003) / 0.015 = 0.5
    expect(kellyFraction(0.7, 0.015, 0.01)).toBeCloseTo(0.5, 4);
  });

  it("returns 0 when Kelly fraction is negative (bad edge)", () => {
    // f = (0.3 × 0.01 - 0.7 × 0.02) / 0.01 = (0.003 - 0.014) / 0.01 < 0
    expect(kellyFraction(0.3, 0.01, 0.02)).toBe(0);
  });

  it("returns 0 when avgWinPct is zero or negative", () => {
    expect(kellyFraction(0.7, 0, 0.01)).toBe(0);
    expect(kellyFraction(0.7, -0.01, 0.01)).toBe(0);
  });

  it("clamps result to [0, 1]", () => {
    const f = kellyFraction(0.99, 0.001, 0.0001);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });
});

describe("parametricVaR", () => {
  it("returns ≈ 0.0497 for 48% vol, 1.645 z-score, 1 day", () => {
    // VaR = 0.48 × sqrt(1/252) × 1.645 ≈ 0.048 × 1.645 ≈ 0.0497
    const var_ = parametricVaR(0.48, 1.645, 1);
    expect(var_).toBeCloseTo(0.0497, 3);
  });

  it("returns a larger value for 99% confidence", () => {
    const var95 = parametricVaR(0.48, 1.645, 1);
    const var99 = parametricVaR(0.48, 2.326, 1);
    expect(var99).toBeGreaterThan(var95!);
  });

  it("result is always in [0, 1]", () => {
    const var_ = parametricVaR(2.0, 3.0, 10); // extreme inputs
    expect(var_).toBeLessThanOrEqual(1);
    expect(var_).toBeGreaterThanOrEqual(0);
  });
});

describe("computeDrawdown", () => {
  it("returns { current: 0, max: 0 } for fewer than 2 points", () => {
    expect(computeDrawdown([])).toEqual({ current: 0, max: 0 });
    expect(computeDrawdown([100])).toEqual({ current: 0, max: 0 });
  });

  it("computes current and max drawdown correctly", () => {
    // [100, 110, 90, 95]: peak=110, current=(110-95)/110≈0.136, max=(110-90)/110≈0.182
    const result = computeDrawdown([100, 110, 90, 95]);
    expect(result.current).toBeCloseTo(0.136, 2);
    expect(result.max).toBeCloseTo(0.182, 2);
  });

  it("returns 0 for all-time high equity curve", () => {
    const result = computeDrawdown([100, 105, 110, 115]);
    expect(result.current).toBe(0);
    expect(result.max).toBe(0);
  });
});

describe("computeMaxPositionSize", () => {
  const defaultCfg = {
    maxKellyFraction: 0.25,
    varConfidence95: 1.645,
    maxDrawdownHalt: 0.2,
    maxPositionRiskPct: 0.02,
  };

  it("returns 0 when currentDrawdown > maxDrawdownHalt", () => {
    const size = computeMaxPositionSize({
      kellyFraction: 0.5,
      var95: 0.05,
      accountEquity: 10000,
      currentDrawdown: 0.25, // exceeds 0.20 limit
      cfg: defaultCfg,
    });
    expect(size).toBe(0);
  });

  it("returns the minimum of Kelly cap and VaR cap", () => {
    // Kelly cap = 0.5 × 0.25 × 10000 = 1250
    // VaR cap = 0.02 × 10000 / 0.05 = 4000
    // Result = min(1250, 4000) = 1250
    const size = computeMaxPositionSize({
      kellyFraction: 0.5,
      var95: 0.05,
      accountEquity: 10000,
      currentDrawdown: 0.05,
      cfg: defaultCfg,
    });
    expect(size).toBeCloseTo(1250, 0);
  });

  it("is always non-negative", () => {
    const size = computeMaxPositionSize({
      kellyFraction: 0,
      var95: 0.1,
      accountEquity: 5000,
      currentDrawdown: 0.01,
      cfg: defaultCfg,
    });
    expect(size).toBeGreaterThanOrEqual(0);
  });
});
