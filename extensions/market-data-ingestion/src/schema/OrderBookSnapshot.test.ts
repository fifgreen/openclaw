import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { OrderBookSnapshotSchema } from "./OrderBookSnapshot.js";

const validSnapshot = {
  exchange: "binance",
  symbol: "BTC/USDT",
  bids: [
    [65000, 0.5],
    [64999, 1.0],
  ],
  asks: [
    [65001, 0.3],
    [65002, 0.8],
  ],
  depth: 2,
  sequenceId: 1234567,
  timestamp: 1700000000000,
};

describe("OrderBookSnapshotSchema", () => {
  it("parses a valid payload without error", () => {
    const result = OrderBookSnapshotSchema.parse(validSnapshot);
    expect(result.symbol).toBe("BTC/USDT");
    expect(result.bids).toHaveLength(2);
    expect(result.asks).toHaveLength(2);
  });

  it("strips extra fields", () => {
    const withExtra = { ...validSnapshot, fooBar: "extra" };
    const result = OrderBookSnapshotSchema.parse(withExtra);
    expect("fooBar" in result).toBe(false);
  });

  it("throws ZodError when a required field is missing", () => {
    const { bids: _bids, ...missing } = validSnapshot;
    expect(() => OrderBookSnapshotSchema.parse(missing)).toThrow(ZodError);
  });

  it("throws ZodError when bids is not an array of tuples", () => {
    const bad = { ...validSnapshot, bids: ["65000", "0.5"] };
    expect(() => OrderBookSnapshotSchema.parse(bad)).toThrow(ZodError);
  });

  it("throws ZodError when sequenceId is a string", () => {
    const bad = { ...validSnapshot, sequenceId: "abc" };
    expect(() => OrderBookSnapshotSchema.parse(bad)).toThrow(ZodError);
  });
});
