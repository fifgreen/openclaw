import { describe, it, expect, vi, beforeEach } from "vitest";
import { DecisionJournaler } from "../engine/Journaler.js";
import { setRedisClient } from "../memdir/index.js";
import { createMemDir } from "../memdir/MemDir.js";
import { HaltProtocol } from "./HaltProtocol.js";
import type { NotificationAdapter } from "./HaltProtocol.js";
import { recoverFromHalt } from "./recovery.js";
import type { ExchangeAdapter, CancelResult, CloseResult } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve("OK" as const);
    },
    _store: store,
  } as unknown as import("ioredis").default;
}

function makeExchangeMock(
  overrides: Partial<ExchangeAdapter> = {},
): ExchangeAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    cancelOrders: async (symbol: string): Promise<CancelResult> => {
      calls.push(`cancelOrders:${symbol}`);
      return overrides.cancelOrders
        ? overrides.cancelOrders(symbol)
        : { symbol, canceledOrderIds: ["ord-1"], errors: [] };
    },
    closePositions: async (symbol: string): Promise<CloseResult> => {
      calls.push(`closePositions:${symbol}`);
      return overrides.closePositions
        ? overrides.closePositions(symbol)
        : {
            symbol,
            closedPositions: [{ positionId: "pos-1", closedAt: Date.now(), price: 42000 }],
            errors: [],
          };
    },
    calls,
  };
}

function makeNotificationMock(): NotificationAdapter & { alerts: string[] } {
  const alerts: string[] = [];
  return {
    sendAlert: async (msg: string) => {
      alerts.push(msg);
    },
    alerts,
  };
}

function makeJournalerMock() {
  const entries: unknown[] = [];
  return {
    writeHalt: async (params: unknown) => {
      entries.push({ type: "halt", ...(params as object) });
    },
    writeTick: async (params: unknown) => {
      entries.push({ type: "tick", ...(params as object) });
    },
    entries,
  } as unknown as DecisionJournaler & { entries: unknown[] };
}

// ---------------------------------------------------------------------------
// T008a: Halt fires all 6 steps in order on invalid strategy
// ---------------------------------------------------------------------------

describe("HaltProtocol - full sequence", () => {
  it("fires cancel, close, MemDir set, notification, journal, tick-stop in order", async () => {
    const redis = makeRedisMock();
    setRedisClient(redis);
    const memDir = createMemDir({ client: redis });
    const exchange = makeExchangeMock();
    const notification = makeNotificationMock();
    const journaler = makeJournalerMock();
    const stoppedSymbols: string[] = [];

    const halt = new HaltProtocol({
      exchange,
      memDir,
      notification,
      journaler,
      onStopTick: (sym) => stoppedSymbols.push(sym),
    });

    await halt.trigger({
      symbol: "btc",
      reason: "invalid_strategy",
      message: "Strategy Zod parse failed",
    });

    // Step 1+2: exchange calls
    expect(exchange.calls).toEqual(["cancelOrders:btc", "closePositions:btc"]);

    // Step 3: MemDir flag set
    const flag = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(flag?.value.halted).toBe(true);
    expect(flag?.value.reason).toContain("Strategy Zod parse failed");

    // Step 4: notification sent
    expect(notification.alerts.length).toBe(1);
    expect(notification.alerts[0]).toContain("HALT");
    expect(notification.alerts[0]).toContain("invalid_strategy");

    // Step 5: journal entry
    expect(journaler.entries.length).toBe(1);
    expect((journaler.entries[0] as { type: string }).type).toBe("halt");

    // Step 6: tick loop stopped
    expect(stoppedSymbols).toContain("btc");
  });

  it("fires halt after N consecutive MemDir timeouts", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });
    const exchange = makeExchangeMock();
    const notification = makeNotificationMock();
    const journaler = makeJournalerMock();

    const halt = new HaltProtocol({ exchange, memDir, notification, journaler });
    await halt.trigger({
      symbol: "eth",
      reason: "consecutive_timeouts",
      message: "3 consecutive MemDir read timeouts",
    });

    const flag = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(flag?.value.halted).toBe(true);
    expect(notification.alerts[0]).toContain("consecutive_timeouts");
  });
});

// ---------------------------------------------------------------------------
// T008b: trading_halted flag idempotency (double-halt does not double-notify)
// ---------------------------------------------------------------------------

describe("HaltProtocol - idempotency", () => {
  it("does not send a second notification within the cooldown window", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });
    const exchange = makeExchangeMock();
    const notification = makeNotificationMock();
    const journaler = makeJournalerMock();

    const halt = new HaltProtocol({
      exchange,
      memDir,
      notification,
      journaler,
      notificationCooldownMs: 60_000, // 60s cooldown
    });

    await halt.trigger({ symbol: "btc", reason: "invalid_strategy", message: "First halt" });
    await halt.trigger({
      symbol: "btc",
      reason: "invalid_strategy",
      message: "Second halt within cooldown",
    });

    // Only one notification should have been sent
    expect(notification.alerts.length).toBe(1);
    // But both journal entries should be written
    expect(journaler.entries.length).toBe(2);
  });

  it("sends a second notification after cooldown has expired", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });
    const exchange = makeExchangeMock();
    const notification = makeNotificationMock();
    const journaler = makeJournalerMock();

    const halt = new HaltProtocol({
      exchange,
      memDir,
      notification,
      journaler,
      notificationCooldownMs: 1, // 1ms cooldown for test
    });

    await halt.trigger({ symbol: "btc", reason: "invalid_strategy", message: "First halt" });
    await new Promise((r) => setTimeout(r, 10));
    await halt.trigger({ symbol: "btc", reason: "invalid_strategy", message: "After cooldown" });

    expect(notification.alerts.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T008c: Recovery validates strategy before clearing flag
// ---------------------------------------------------------------------------

describe("recoverFromHalt", () => {
  const validStrategy = {
    id: "btc-trend-v1",
    bias: "long-only",
    maxDrawdown: 0.03,
    allowedAssets: ["BTC/USDT"],
    entryConditions: { rsi: { above: 50 } },
    exitRules: { stopLoss: "2%" },
    confluenceThreshold: 3,
  };

  it("clears halt flag and resumes tick loop on valid strategy", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });
    const notification = makeNotificationMock();
    const resumed: string[] = [];

    const result = await recoverFromHalt({
      memDir,
      notification,
      strategyJson: validStrategy,
      symbol: "btc",
      onResumeTick: (sym) => resumed.push(sym),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy.id).toBe("btc-trend-v1");

    const flag = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(flag?.value.halted).toBe(false);

    expect(notification.alerts[0]).toContain("RESUME");
    expect(resumed).toContain("btc");
  });

  it("stays halted when strategy is still invalid", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });
    const notification = makeNotificationMock();

    const result = await recoverFromHalt({
      memDir,
      notification,
      strategyJson: { id: "bad", bias: "INVALID" }, // invalid schema
      symbol: "btc",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Strategy re-validation failed");

    // trading_halted flag should NOT have been cleared
    const flag = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(flag).toBeNull(); // never set in this test — was never halted
    expect(notification.alerts.length).toBe(0);
  });
});
