import { describe, it, expect, vi } from "vitest";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import { OrderBookStateMachine } from "./OrderBookStateMachine.js";

/** Build a minimal delta snapshot */
function makeDelta(
  seqId: number,
  bids: [number, number][] = [[65000, 0.5]],
  asks: [number, number][] = [[65001, 0.3]],
  exchange = "binance",
  symbol = "BTC/USDT",
): OrderBookSnapshot {
  return {
    exchange,
    symbol,
    bids,
    asks,
    depth: Math.max(bids.length, asks.length),
    sequenceId: seqId,
    timestamp: Date.now(),
  };
}

function makeMachine(seqIdForSnapshot = 0) {
  const fetchSnapshot = vi
    .fn()
    .mockResolvedValue(makeDelta(seqIdForSnapshot, [[65000, 1.0]], [[65010, 1.0]]));
  const machine = new OrderBookStateMachine({
    exchange: "binance",
    symbol: "BTC/USDT",
    depth: 5,
    fetchSnapshot,
  });
  return { machine, fetchSnapshot };
}

describe("OrderBookStateMachine", () => {
  it("starts in 'uninitialized' status", () => {
    const { machine } = makeMachine();
    expect(machine.status).toBe("uninitialized");
  });

  it("transitions to 'snapshotting' on first delta, then 'live' after snapshot", async () => {
    const { machine } = makeMachine(1);
    machine.applyDelta(makeDelta(2));
    expect(machine.status).toBe("snapshotting");
    // Let snapshot fetch resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(machine.status).toBe("live");
  });

  it("sequential deltas update bids/asks correctly", async () => {
    const { machine } = makeMachine(0);
    machine.applyDelta(makeDelta(1));
    await new Promise((r) => setTimeout(r, 0));
    // seqId=1 already applied via replay, now seqId=2
    machine.applyDelta(makeDelta(2, [[65100, 2.0]], [[65200, 1.5]]));
    const top = machine.getTopOfBook(5);
    expect(top).toBeDefined();
    expect(top?.bids.some(([p]) => p === 65100)).toBe(true);
  });

  it("gap in seqId triggers 'resyncing' and calls fetchSnapshot", async () => {
    const { machine, fetchSnapshot } = makeMachine(0);
    // Bootstrap machine to live state
    machine.applyDelta(makeDelta(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(machine.status).toBe("live");

    // Now inject a gap (skip seqId 2, send 3)
    machine.applyDelta(makeDelta(3));
    expect(machine.status).toBe("resyncing");

    await new Promise((r) => setTimeout(r, 0));
    expect(machine.status).toBe("live");
    expect(fetchSnapshot).toHaveBeenCalledTimes(2); // initial + resync
  });

  it("duplicate seqId is silently discarded", async () => {
    const { machine } = makeMachine(0);
    machine.applyDelta(makeDelta(1));
    await new Promise((r) => setTimeout(r, 0));

    // Push seqId=1 again — the machine is live at seqId=1+snapshot replay
    // Any delta with seqId <= lastSequenceId should be silently discarded
    const top1 = machine.getTopOfBook(5);
    machine.applyDelta(makeDelta(1)); // duplicate
    const top2 = machine.getTopOfBook(5);
    // Book should not have changed
    expect(JSON.stringify(top1)).toBe(JSON.stringify(top2));
  });

  it("qty === 0 removes the price level", async () => {
    const { machine } = makeMachine(0);
    machine.applyDelta(makeDelta(1, [[65000, 1.0]], [[65010, 1.0]]));
    await new Promise((r) => setTimeout(r, 0));

    // Remove bid level 65000 with qty=0
    machine.applyDelta(makeDelta(2, [[65000, 0]], [[65020, 0.5]]));
    const top = machine.getTopOfBook(5);
    expect(top?.bids.some(([p]) => p === 65000)).toBe(false);
  });

  it("depth-5 getTopOfBook returns at most 5 levels on each side", async () => {
    const bids: [number, number][] = Array.from({ length: 10 }, (_, i) => [65000 - i, 1]);
    const asks: [number, number][] = Array.from({ length: 10 }, (_, i) => [65010 + i, 1]);
    const fetchSnapshot = vi.fn().mockResolvedValue(makeDelta(0, bids, asks));
    const machine = new OrderBookStateMachine({
      exchange: "binance",
      symbol: "BTC/USDT",
      depth: 5,
      fetchSnapshot,
    });
    machine.applyDelta(makeDelta(1));
    await new Promise((r) => setTimeout(r, 0));

    const top = machine.getTopOfBook(5);
    expect(top?.bids).toHaveLength(5);
    expect(top?.asks).toHaveLength(5);
  });

  it("all query methods return undefined during 'resyncing'", async () => {
    const fetchSnapshot = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<OrderBookSnapshot>((resolve) => setTimeout(() => resolve(makeDelta(0)), 200)),
      );
    const machine = new OrderBookStateMachine({
      exchange: "binance",
      symbol: "BTC/USDT",
      depth: 5,
      fetchSnapshot,
    });

    // Bootstrap to live
    const initialFetch = vi.fn().mockResolvedValue(makeDelta(0));
    const quickMachine = new OrderBookStateMachine({
      exchange: "binance",
      symbol: "BTC/USDT",
      depth: 5,
      fetchSnapshot: initialFetch,
    });
    quickMachine.applyDelta(makeDelta(1));
    await new Promise((r) => setTimeout(r, 0));

    // Now inject gap to trigger resyncing without immediately resolving
    const slowFetch = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<OrderBookSnapshot>((resolve) => setTimeout(() => resolve(makeDelta(0)), 200)),
      );
    const slowMachine = new OrderBookStateMachine({
      exchange: "binance",
      symbol: "BTC/USDT",
      depth: 5,
      fetchSnapshot: slowFetch,
    });
    slowMachine.applyDelta(makeDelta(1));
    // Still snapshotting synchronously after first applyDelta
    expect(slowMachine.status).toBe("snapshotting");
    expect(slowMachine.getTopOfBook(5)).toBeUndefined();
    expect(slowMachine.getMidprice()).toBeUndefined();
    expect(slowMachine.getSpread()).toBeUndefined();
    expect(slowMachine.getImbalance(5)).toBeUndefined();
  });
});
