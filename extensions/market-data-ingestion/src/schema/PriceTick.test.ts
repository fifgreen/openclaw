import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { PriceTickSchema } from "./PriceTick.js";

const validTick = {
  exchange: "binance",
  symbol: "BTC/USDT",
  price: 65000.5,
  quantity: 0.01,
  side: "buy" as const,
  tradeId: "abc123",
  timestamp: 1700000000000,
  localTimestamp: 1700000000001,
};

describe("PriceTickSchema", () => {
  it("parses a valid payload without error", () => {
    const result = PriceTickSchema.parse(validTick);
    expect(result.symbol).toBe("BTC/USDT");
    expect(result.side).toBe("buy");
  });

  it("strips extra fields", () => {
    const withExtra = { ...validTick, extraField: "should-be-stripped" };
    const result = PriceTickSchema.parse(withExtra);
    expect("extraField" in result).toBe(false);
  });

  it("throws ZodError when a required field is missing", () => {
    const { price: _price, ...missing } = validTick;
    expect(() => PriceTickSchema.parse(missing)).toThrow(ZodError);
  });

  it("throws ZodError when a numeric field is given a string", () => {
    const bad = { ...validTick, price: "65000" };
    expect(() => PriceTickSchema.parse(bad)).toThrow(ZodError);
  });

  it("throws ZodError when side is an invalid enum value", () => {
    const bad = { ...validTick, side: "hold" };
    expect(() => PriceTickSchema.parse(bad)).toThrow(ZodError);
  });
});
