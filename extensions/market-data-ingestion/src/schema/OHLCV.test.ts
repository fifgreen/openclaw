import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { OHLCVSchema } from "./OHLCV.js";

const validOHLCV = {
  symbol: "BTC/USDT",
  timeframe: "1m" as const,
  open: 65000,
  high: 65200,
  low: 64900,
  close: 65100,
  volume: 123.45,
  timestamp: 1700000000000,
};

describe("OHLCVSchema", () => {
  it("parses a valid 1m payload without error", () => {
    const result = OHLCVSchema.parse(validOHLCV);
    expect(result.timeframe).toBe("1m");
    expect(result.close).toBe(65100);
  });

  it("parses valid 5m and 1h timeframes", () => {
    expect(OHLCVSchema.parse({ ...validOHLCV, timeframe: "5m" }).timeframe).toBe("5m");
    expect(OHLCVSchema.parse({ ...validOHLCV, timeframe: "1h" }).timeframe).toBe("1h");
  });

  it("strips extra fields", () => {
    const withExtra = { ...validOHLCV, extra: "ignored" };
    const result = OHLCVSchema.parse(withExtra);
    expect("extra" in result).toBe(false);
  });

  it("throws ZodError when a required field is missing", () => {
    const { close: _close, ...missing } = validOHLCV;
    expect(() => OHLCVSchema.parse(missing)).toThrow(ZodError);
  });

  it("throws ZodError when timeframe is invalid", () => {
    expect(() => OHLCVSchema.parse({ ...validOHLCV, timeframe: "15m" })).toThrow(ZodError);
  });

  it("throws ZodError when a numeric field is given a string", () => {
    expect(() => OHLCVSchema.parse({ ...validOHLCV, open: "65000" })).toThrow(ZodError);
  });
});
