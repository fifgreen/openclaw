import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { FundingRateSchema } from "./FundingRate.js";

const validRate = {
  exchange: "bybit",
  symbol: "BTC/USDT",
  rate: 0.0001,
  nextFundingTime: 1700003600000,
  timestamp: 1700000000000,
};

describe("FundingRateSchema", () => {
  it("parses a valid payload without error", () => {
    const result = FundingRateSchema.parse(validRate);
    expect(result.rate).toBe(0.0001);
    expect(result.exchange).toBe("bybit");
  });

  it("strips extra fields", () => {
    const withExtra = { ...validRate, unexpected: "value" };
    const result = FundingRateSchema.parse(withExtra);
    expect("unexpected" in result).toBe(false);
  });

  it("throws ZodError when a required field is missing", () => {
    const { rate: _rate, ...missing } = validRate;
    expect(() => FundingRateSchema.parse(missing)).toThrow(ZodError);
  });

  it("throws ZodError when rate is given a string", () => {
    const bad = { ...validRate, rate: "0.0001" };
    expect(() => FundingRateSchema.parse(bad)).toThrow(ZodError);
  });

  it("throws ZodError when nextFundingTime is given a string", () => {
    const bad = { ...validRate, nextFundingTime: "2024-01-01" };
    expect(() => FundingRateSchema.parse(bad)).toThrow(ZodError);
  });
});
