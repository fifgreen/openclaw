import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setRedisClient } from "./index.js";
import { createMemDir } from "./MemDir.js";

// ---------------------------------------------------------------------------
// Minimal Redis mock
// ---------------------------------------------------------------------------

function createRedisMock(
  overrides: Partial<{ get: () => Promise<string | null>; set: () => Promise<"OK"> }> = {},
) {
  const store = new Map<string, string>();
  return {
    get: overrides.get ?? ((key: string) => Promise.resolve(store.get(key) ?? null)),
    set:
      overrides.set ??
      ((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve("OK" as const);
      }),
    _store: store,
  } as unknown as import("ioredis").default;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// T005a: Typed key read/write roundtrip
// ---------------------------------------------------------------------------

describe("MemDir typed key roundtrip", () => {
  it("writes and reads back a value with correct shape", async () => {
    const mock = createRedisMock();
    setRedisClient(mock);
    const memDir = createMemDir({ client: mock });

    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-on", { source: "test-feed" });

    const result = await memDir.get({ key: "macro_regime", symbol: "btc" });
    expect(result).not.toBeNull();
    expect(result?.value).toBe("risk-on");
    expect(result?.source).toBe("test-feed");
    expect(typeof result?.updatedAt).toBe("number");
  });

  it("returns null for a key that was never set", async () => {
    const mock = createRedisMock();
    const memDir = createMemDir({ client: mock });
    const result = await memDir.get({ key: "fear_greed", symbol: "eth" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T005b: TTL expiry
// ---------------------------------------------------------------------------

describe("MemDir TTL expiry", () => {
  it("returns null when value has exceeded its TTL", async () => {
    vi.useRealTimers();
    const mock = createRedisMock();
    const memDir = createMemDir({ client: mock });

    // Write with a very short TTL
    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-off", {
      source: "feed",
      ttlMs: 1,
    });

    // Advance real time (sleep 10ms)
    await new Promise((r) => setTimeout(r, 10));

    const result = await memDir.get({ key: "macro_regime", symbol: "btc" });
    expect(result).toBeNull();
  });

  it("returns value when within TTL window", async () => {
    const mock = createRedisMock();
    const memDir = createMemDir({ client: mock });

    await memDir.set({ key: "macro_regime", symbol: "btc" }, "neutral", {
      source: "feed",
      ttlMs: 60_000,
    });

    const result = await memDir.get({ key: "macro_regime", symbol: "btc" });
    expect(result?.value).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// T005c: Bounded timeout behavior
// ---------------------------------------------------------------------------

describe("MemDir bounded timeout", () => {
  it("returns null and does not hang when Redis is slow", async () => {
    vi.useRealTimers();
    // Mock Redis that never resolves
    const hangingRedis = {
      get: () => new Promise<never>(() => {}),
      set: () => Promise.resolve("OK" as const),
    } as unknown as import("ioredis").default;

    const memDir = createMemDir({ client: hangingRedis, timeoutMs: 50 });

    const start = Date.now();
    const result = await memDir.get({ key: "macro_regime", symbol: "btc" });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(500); // Should resolve well within 500ms
  });
});

// ---------------------------------------------------------------------------
// T005d: Namespace isolation
// ---------------------------------------------------------------------------

describe("MemDir namespace isolation", () => {
  it("BTC and ETH keys do not collide", async () => {
    const mock = createRedisMock();
    const memDir = createMemDir({ client: mock });

    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-on", { source: "feed" });
    await memDir.set({ key: "macro_regime", symbol: "eth" }, "risk-off", { source: "feed" });

    const btcResult = await memDir.get({ key: "macro_regime", symbol: "btc" });
    const ethResult = await memDir.get({ key: "macro_regime", symbol: "eth" });

    expect(btcResult?.value).toBe("risk-on");
    expect(ethResult?.value).toBe("risk-off");
  });

  it("global keys use * symbol and do not collide with symbol-scoped keys", async () => {
    const mock = createRedisMock();
    const memDir = createMemDir({ client: mock });

    await memDir.set(
      { key: "trading_halted", symbol: "*" },
      { halted: true, reason: "test", haltedAt: Date.now() },
      { source: "risk-coordinator" },
    );

    const result = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(result?.value.halted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T005e: Concurrent write — latest wins
// ---------------------------------------------------------------------------

describe("MemDir concurrent write", () => {
  it("last write wins and updatedAt reflects the winner", async () => {
    vi.useRealTimers();
    const mock = createRedisMock();
    const memDir = createMemDir({ client: mock });

    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-on", { source: "feed-a" });
    await new Promise((r) => setTimeout(r, 5));
    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-off", { source: "feed-b" });

    const result = await memDir.get({ key: "macro_regime", symbol: "btc" });
    expect(result?.value).toBe("risk-off");
    expect(result?.source).toBe("feed-b");
  });
});
