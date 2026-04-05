import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import type { PriceTick } from "../schema/PriceTick.js";
import { WriteBuffer } from "./WriteBuffer.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function makeTick(i: number): PriceTick {
  return {
    exchange: "binance",
    symbol: "BTC/USDT",
    price: 65000 + i,
    quantity: 0.01,
    side: "buy",
    tradeId: `t${i}`,
    timestamp: Date.now() + i,
    localTimestamp: Date.now() + i,
  };
}

function makeOBSnapshot(i: number): OrderBookSnapshot {
  return {
    exchange: "binance",
    symbol: "BTC/USDT",
    bids: [[65000 - i, 1]],
    asks: [[65001 + i, 1]],
    depth: 1,
    sequenceId: i,
    timestamp: Date.now() + i,
  };
}

describe("WriteBuffer backpressure integration", () => {
  it("5000 ticks trigger at most 5 flush calls (maxRows=1000)", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const tickBuf = new WriteBuffer<PriceTick>({
      maxRows: 1000,
      flushIntervalMs: 10_000,
      maxQueueDepth: 10_000,
      onFlush,
    });
    tickBuf.start();

    for (let i = 0; i < 5000; i++) tickBuf.push(makeTick(i));
    // Resolve all pending microtasks from flush calls
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Remaining rows flushed by stop()
    await tickBuf.stop();

    // 5000 rows / 1000 per flush = exactly 5 flush calls
    expect(onFlush.mock.calls.length).toBeLessThanOrEqual(5);
    // All 5000 rows must have been delivered
    const totalFlushed = (onFlush.mock.calls as PriceTick[][][]).flat(1).flat().length;
    expect(totalFlushed).toBe(5000);
  });

  it("OB buffer with maxQueueDepth=Infinity never drops rows", async () => {
    const obFlush = vi.fn().mockResolvedValue(undefined);
    const obBuf = new WriteBuffer<OrderBookSnapshot>({
      maxRows: 1000,
      flushIntervalMs: 10_000,
      maxQueueDepth: Infinity,
      onFlush: obFlush,
    });
    obBuf.start();

    for (let i = 0; i < 50; i++) obBuf.push(makeOBSnapshot(i));
    await obBuf.stop();

    const totalFlushed = (obFlush.mock.calls as OrderBookSnapshot[][][]).flat(1).flat().length;
    expect(totalFlushed).toBe(50);
  });

  it("tick buffer overflow drops oldest row and logs warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const tickBuf = new WriteBuffer<PriceTick>({
      maxRows: 100_000, // won't auto-flush
      flushIntervalMs: 100_000,
      maxQueueDepth: 3,
      onFlush,
    });
    tickBuf.start();

    tickBuf.push(makeTick(1));
    tickBuf.push(makeTick(2));
    tickBuf.push(makeTick(3));
    tickBuf.push(makeTick(4)); // triggers drop

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("backpressure"));

    await tickBuf.stop();
    const totalFlushed = (onFlush.mock.calls as PriceTick[][][]).flat(1).flat().length;
    expect(totalFlushed).toBe(3); // 3 survive after 1 drop
    warnSpy.mockRestore();
  });

  it("concurrent tick and OB pushes do not interfere", async () => {
    const tickFlush = vi.fn().mockResolvedValue(undefined);
    const obFlush = vi.fn().mockResolvedValue(undefined);

    const tickBuf = new WriteBuffer<PriceTick>({
      maxRows: 1000,
      flushIntervalMs: 10_000,
      maxQueueDepth: Infinity,
      onFlush: tickFlush,
    });
    const obBuf = new WriteBuffer<OrderBookSnapshot>({
      maxRows: 1000,
      flushIntervalMs: 10_000,
      maxQueueDepth: Infinity,
      onFlush: obFlush,
    });
    tickBuf.start();
    obBuf.start();

    for (let i = 0; i < 2500; i++) tickBuf.push(makeTick(i));
    for (let i = 0; i < 50; i++) obBuf.push(makeOBSnapshot(i));

    await Promise.resolve();
    await Promise.resolve();
    await tickBuf.stop();
    await obBuf.stop();

    const totalTicks = (tickFlush.mock.calls as PriceTick[][][]).flat(1).flat().length;
    const totalOB = (obFlush.mock.calls as OrderBookSnapshot[][][]).flat(1).flat().length;
    expect(totalTicks).toBe(2500);
    expect(totalOB).toBe(50);
  });
});
