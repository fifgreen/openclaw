/**
 * Integration tests: full tick cycle (T021) and halt trigger + recovery (T022).
 *
 * These tests wire all major components together using controlled mocks:
 * - MemDir backed by a fake Redis client
 * - ContextEngine assembling a real prompt
 * - HaltProtocol firing the 6-step sequence
 * - DecisionJournaler writing to a temp directory
 * - recoverFromHalt clearing the halt flag
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextEngine } from "./engine/ContextEngine.js";
import { AgentSessionHistory } from "./engine/History.js";
import { DecisionJournaler, readRecentJournalEntries } from "./engine/Journaler.js";
import { HaltProtocol } from "./halt/HaltProtocol.js";
import type { NotificationAdapter } from "./halt/HaltProtocol.js";
import type { RecoveryOptions } from "./halt/recovery.js";
import { recoverFromHalt } from "./halt/recovery.js";
import type { ExchangeAdapter, CancelResult, CloseResult } from "./halt/types.js";
import { createMemDir } from "./memdir/MemDir.js";
import type { MemDir } from "./memdir/MemDir.js";

// ---------------------------------------------------------------------------
// Minimal Redis-compatible in-memory store for integration tests
// ---------------------------------------------------------------------------

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve("OK" as const);
    },
  } as unknown as import("ioredis").default;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockExchange(
  opts: {
    cancelError?: string;
    closeError?: string;
  } = {},
): ExchangeAdapter {
  return {
    cancelOrders: async (symbol): Promise<CancelResult> => ({
      symbol,
      canceledOrderIds: opts.cancelError ? [] : ["order-001"],
      errors: opts.cancelError ? [opts.cancelError] : [],
    }),
    closePositions: async (symbol): Promise<CloseResult> => ({
      symbol,
      closedPositions: opts.closeError
        ? []
        : [{ positionId: "pos-001", closedAt: Date.now(), price: 50_000 }],
      errors: opts.closeError ? [opts.closeError] : [],
    }),
  };
}

function makeMockNotification(): NotificationAdapter & { alerts: string[] } {
  const alerts: string[] = [];
  return {
    alerts,
    async sendAlert(message) {
      alerts.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// T021: Full tick cycle
// ---------------------------------------------------------------------------

describe("integration: full tick cycle (T021)", () => {
  let journalDir: string;
  let memDir: MemDir;

  beforeEach(async () => {
    journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-ctx-int-"));
    const redis = makeRedisMock();
    memDir = createMemDir({ client: redis });
  });

  afterEach(async () => {
    await fs.rm(journalDir, { recursive: true, force: true });
  });

  it("assembles a context prompt with risk + strategy sections", async () => {
    // Write macro context into MemDir
    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-off", {
      source: "test",
      ttlMs: 4 * 60 * 60 * 1000,
    });
    await memDir.set(
      { key: "fear_greed", symbol: "btc" },
      { score: 25, classification: "extreme-fear" },
      { source: "test", ttlMs: 4 * 60 * 60 * 1000 },
    );

    const mockHalt = {
      trigger: async () => {},
    } as unknown as HaltProtocol;

    const engine = new ContextEngine({
      memDir,
      haltProtocol: mockHalt,
      tokenBudget: 4_000,
      symbol: "btc",
      sessionId: "sess-test-001",
    });

    const history = new AgentSessionHistory({ sessionId: "sess-test-001", symbol: "btc" });
    history.push({
      role: "user",
      content: "What is the current market regime?",
      timestamp: Date.now(),
    });
    history.push({
      role: "assistant",
      content: "The macro regime is risk-off.",
      timestamp: Date.now(),
    });

    const strategy = {
      id: "conservative-long",
      bias: "long-only" as const,
      maxDrawdown: 0.02,
      allowedAssets: ["BTC/USDT"],
      entryConditions: { rsi: { above: 40 } },
      exitRules: { stopLoss: "2%", takeProfit: "4%" },
      confluenceThreshold: 2,
    };

    const assembled = await engine.assemble({ history: history.getAll(), strategy });

    expect(assembled.systemPrompt).toContain("risk-off");
    expect(assembled.systemPrompt).toContain("LONG-ONLY"); // strategy directive
    expect(assembled.systemPrompt).toContain("2.0%"); // maxDrawdown
    expect(assembled.systemPrompt).toContain("BTC/USDT"); // allowedAssets
    expect(assembled.totalTokens).toBeGreaterThan(0);
    expect(assembled.truncatedHistoryCount).toBe(0);
  });

  it("journals a tick decision to JSONL", async () => {
    const journaler = new DecisionJournaler({ journalDir, sessionId: "sess-test-001" });

    await journaler.writeTick({
      symbol: "btc",
      memDirSnapshot: { macro_regime: "risk-off" },
      strategyId: "conservative-long",
      quantSignals: {},
      reasoning: "Market regime is risk-off; holding cash.",
      action: "hold",
    });

    const entries = await readRecentJournalEntries(journalDir, 10);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("tick");
    if (entry!.type === "tick") {
      expect(entry.action).toBe("hold");
      expect(entry.strategyId).toBe("conservative-long");
    }
  });

  it("round-trips MemDir state for multiple symbols", async () => {
    await memDir.set({ key: "macro_regime", symbol: "btc" }, "risk-off", {
      source: "test",
      ttlMs: 4 * 60 * 60 * 1000,
    });
    await memDir.set({ key: "macro_regime", symbol: "eth" }, "neutral", {
      source: "test",
      ttlMs: 4 * 60 * 60 * 1000,
    });

    const btc = await memDir.get({ key: "macro_regime", symbol: "btc" });
    const eth = await memDir.get({ key: "macro_regime", symbol: "eth" });

    expect(btc?.value).toBe("risk-off");
    expect(eth?.value).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// T022: Halt trigger + recovery
// ---------------------------------------------------------------------------

describe("integration: halt trigger and recovery (T022)", () => {
  let journalDir: string;
  let memDir: MemDir;

  beforeEach(async () => {
    journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-ctx-halt-"));
    const redis = makeRedisMock();
    memDir = createMemDir({ client: redis });
  });

  afterEach(async () => {
    await fs.rm(journalDir, { recursive: true, force: true });
  });

  it("triggers halt, sets MemDir flag, notifies operator, and journals", async () => {
    const exchange = makeMockExchange();
    const notification = makeMockNotification();
    const journaler = new DecisionJournaler({ journalDir, sessionId: "sess-halt-001" });
    let tickStopped = false;

    const halt = new HaltProtocol({
      exchange,
      memDir,
      notification,
      journaler,
      onStopTick: () => {
        tickStopped = true;
      },
    });

    await halt.trigger({
      reason: "manual_stop",
      symbol: "btc",
      message: "Operator requested halt.",
    });

    // Halt flag set in MemDir
    const flagEntry = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(flagEntry?.value.halted).toBe(true);

    // Tick stopped
    expect(tickStopped).toBe(true);

    // Notification sent
    expect(notification.alerts.length).toBeGreaterThan(0);

    // Halt journaled
    const entries = await readRecentJournalEntries(journalDir, 10);
    const haltEntry = entries.find((e) => e.type === "halt");
    expect(haltEntry).toBeDefined();
    if (haltEntry?.type === "halt") {
      expect(haltEntry.reason).toBe("manual_stop");
    }
  });

  it("recovery clears halt flag and returns ok=true for valid strategy", async () => {
    // Pre-set the halt flag
    await memDir.set(
      { key: "trading_halted", symbol: "*" },
      { halted: true, reason: "test halt", haltedAt: Date.now() },
      { source: "halt-protocol" },
    );

    const validStrategy = {
      id: "recovery-test",
      bias: "both" as const,
      maxDrawdown: 0.03,
      allowedAssets: ["BTC/USDT"],
      entryConditions: { rsi: { above: 45 } },
      exitRules: { stopLoss: "1.5%" },
      confluenceThreshold: 3,
    };

    let tickResumed = false;
    const opts: RecoveryOptions = {
      strategyJson: validStrategy,
      memDir,
      symbol: "btc",
      onResumeTick: () => {
        tickResumed = true;
      },
      notification: {
        async sendAlert() {},
      },
    };
    const result = await recoverFromHalt(opts);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy.id).toBe("recovery-test");
    }
    expect(tickResumed).toBe(true);

    // Halt flag cleared (resumed)
    const flagAfter = await memDir.get({ key: "trading_halted", symbol: "*" });
    expect(flagAfter?.value.halted).toBe(false);
  });

  it("recovery returns ok=false for invalid strategy", async () => {
    await memDir.set(
      { key: "trading_halted", symbol: "*" },
      { halted: true, reason: "test halt", haltedAt: Date.now() },
      { source: "halt-protocol" },
    );

    let tickResumed = false;
    const result = await recoverFromHalt({
      strategyJson: { id: "", allowedAssets: [] },
      memDir,
      symbol: "btc",
      onResumeTick: () => {
        tickResumed = true;
      },
      notification: { async sendAlert() {} },
    });

    expect(result.ok).toBe(false);
    expect(tickResumed).toBe(false);
  });

  it("halt notification is deduplicated within cooldown window", async () => {
    const exchange = makeMockExchange();
    const notification = makeMockNotification();
    const journaler = new DecisionJournaler({ journalDir, sessionId: "sess-dedup-001" });

    const halt = new HaltProtocol({
      exchange,
      memDir,
      notification,
      journaler,
      notificationCooldownMs: 600_000, // 10 minutes
    });

    // First halt
    await halt.trigger({ reason: "manual_stop", symbol: "btc", message: "First halt." });
    const firstAlerts = notification.alerts.length;

    // Second halt within cooldown — notification should be skipped
    await halt.trigger({ reason: "consecutive_timeouts", symbol: "btc", message: "Second halt." });
    expect(notification.alerts.length).toBe(firstAlerts);
  });
});
