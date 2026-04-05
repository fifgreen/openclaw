import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WriteBuffer } from "./WriteBuffer.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WriteBuffer", () => {
  it("flushes immediately when maxRows threshold is hit", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new WriteBuffer<number>({
      maxRows: 3,
      flushIntervalMs: 10000,
      maxQueueDepth: Infinity,
      onFlush,
    });
    buf.start();

    buf.push(1);
    buf.push(2);
    // Not yet flushed
    expect(onFlush).not.toHaveBeenCalled();
    buf.push(3);
    // Flush triggered — onFlush is async so tick microtasks
    await Promise.resolve();
    expect(onFlush).toHaveBeenCalledWith([1, 2, 3]);

    await buf.stop();
  });

  it("flushes when interval elapses with fewer than maxRows rows", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new WriteBuffer<number>({
      maxRows: 100,
      flushIntervalMs: 500,
      maxQueueDepth: Infinity,
      onFlush,
    });
    buf.start();

    buf.push(42);
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(onFlush).toHaveBeenCalledWith([42]);

    await buf.stop();
  });

  it("drops oldest row and emits warning when maxQueueDepth exceeded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new WriteBuffer<number>({
      maxRows: 1000, // won't auto-flush during this test
      flushIntervalMs: 10000,
      maxQueueDepth: 3,
      onFlush,
    });
    buf.start();

    buf.push(1);
    buf.push(2);
    buf.push(3);
    // capacity = 3; next push must drop oldest
    buf.push(4);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("backpressure"));
    // After stop we drain what's in the buffer (rows 2, 3, 4)
    await buf.stop();
    const flushed = onFlush.mock.calls.flat(1) as number[][];
    const allFlushed = flushed.flat();
    expect(allFlushed).not.toContain(1);
    expect(allFlushed).toContain(4);

    warnSpy.mockRestore();
  });

  it("never drops rows when maxQueueDepth is Infinity", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new WriteBuffer<number>({
      maxRows: 1000,
      flushIntervalMs: 10000,
      maxQueueDepth: Infinity,
      onFlush,
    });
    buf.start();

    for (let i = 0; i < 5000; i++) buf.push(i);

    await buf.stop();
    const totalFlushed = (onFlush.mock.calls as number[][][]).flat(1).flat().length;
    expect(totalFlushed).toBe(5000);
  });

  it("stop() drains remaining rows and resolves", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new WriteBuffer<string>({
      maxRows: 1000,
      flushIntervalMs: 10000,
      maxQueueDepth: Infinity,
      onFlush,
    });
    buf.start();

    buf.push("a");
    buf.push("b");

    await buf.stop();
    expect(onFlush).toHaveBeenCalledWith(["a", "b"]);
  });

  it("concurrent push calls do not corrupt the buffer", async () => {
    const flushed: number[] = [];
    const onFlush = vi.fn().mockImplementation(async (rows: number[]) => {
      flushed.push(...rows);
    });
    const buf = new WriteBuffer<number>({
      maxRows: 10,
      flushIntervalMs: 10000,
      maxQueueDepth: Infinity,
      onFlush,
    });
    buf.start();

    // Push 25 items; 2x maxRows flush + 5 leftover
    for (let i = 0; i < 25; i++) buf.push(i);
    await Promise.resolve();

    await buf.stop();
    // All 25 distinct values must appear exactly once
    expect(flushed.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});
