import { describe, it, expect, vi } from "vitest";
import { HaltProtocol } from "../halt/HaltProtocol.js";
import { setRedisClient } from "../memdir/index.js";
import { createMemDir } from "../memdir/MemDir.js";
import { ContextEngine } from "./ContextEngine.js";
import type { HistoryEntry } from "./History.js";
import type { StrategyOverride } from "./StrategyParser.js";

// ---------------------------------------------------------------------------
// Helpers
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

const baseStrategy: StrategyOverride = {
  id: "btc-trend-v1",
  bias: "long-only",
  maxDrawdown: 0.03,
  allowedAssets: ["BTC/USDT"],
  entryConditions: { rsi: { above: 50 } },
  exitRules: { atrTp: "2x" },
  confluenceThreshold: 3,
};

function makeHaltMock(): HaltProtocol {
  return { trigger: vi.fn(), execute: vi.fn() } as unknown as HaltProtocol;
}

// ---------------------------------------------------------------------------
// T011a: Risk alerts survive truncation even at 100% budget
// ---------------------------------------------------------------------------

describe("ContextEngine priority — risk alerts", () => {
  it("includes risk flags even when token budget is extremely tight", async () => {
    const redis = makeRedisMock();
    setRedisClient(redis);
    const memDir = createMemDir({ client: redis });

    // Set a halt flag
    await memDir.set(
      { key: "trading_halted", symbol: "*" },
      { halted: true, reason: "test-halt", haltedAt: Date.now() },
      { source: "test" },
    );

    // Engine with a very small budget so history would be truncated
    const engine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "s1",
      tokenBudget: 500,
    });

    const history: HistoryEntry[] = Array.from({ length: 50 }, (_, i) => ({
      role: "assistant" as const,
      content: `Decision ${i}: HOLD based on current signals.`,
      timestamp: Date.now() - i * 1000,
    }));

    const result = await engine.assemble({ strategy: baseStrategy, history });

    expect(result.systemPrompt).toContain("TRADING HALTED");
    expect(result.systemPrompt).toContain("test-halt");
  });
});

// ---------------------------------------------------------------------------
// T011b: Oversized history gets truncated to fit
// ---------------------------------------------------------------------------

describe("ContextEngine truncation", () => {
  it("truncates oldest history entries when over threshold", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });

    const engine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "s1",
      tokenBudget: 300,
      truncationThreshold: 0.9,
    });

    const history: HistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      role: "assistant" as const,
      content: `Long decision text for tick number ${i} that takes up tokens: HOLD because RSI is 52 and momentum is sideways.`,
      timestamp: Date.now() - i * 1000,
    }));

    const result = await engine.assemble({ strategy: baseStrategy, history });

    expect(result.truncatedHistoryCount).toBeGreaterThan(0);
    expect(result.totalTokens).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// T011c: Truncation banner is present when history is shed
// ---------------------------------------------------------------------------

describe("ContextEngine truncation banner", () => {
  it("includes CONTEXT_TRUNCATED banner when history is trimmed", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });

    const engine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "s1",
      tokenBudget: 300,
      truncationThreshold: 0.9,
    });

    const history: HistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      role: "assistant" as const,
      content: `Long decision text for tick number ${i}: HOLD.`,
      timestamp: Date.now() - i * 1000,
    }));

    const result = await engine.assemble({ strategy: baseStrategy, history });

    if (result.truncatedHistoryCount > 0) {
      expect(result.systemPrompt).toContain("<<CONTEXT_TRUNCATED:");
      expect(result.systemPrompt).toContain(
        `${result.truncatedHistoryCount} conversation entries removed`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T011d: Strategy overrides are preserved verbatim
// ---------------------------------------------------------------------------

describe("ContextEngine strategy preservation", () => {
  it("includes strategy bias directive in assembled prompt", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });

    const engine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "s1",
    });

    const result = await engine.assemble({ strategy: baseStrategy, history: [] });

    expect(result.systemPrompt).toContain("LONG-ONLY");
    expect(result.systemPrompt).toContain("3.0%"); // maxDrawdown
    expect(result.systemPrompt).toContain("BTC/USDT");
    expect(result.systemPrompt).toContain("CONFLUENCE GATE");
  });

  it("strategy directives survive truncation even at max capacity", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });

    const engine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "s1",
      tokenBudget: 300,
    });

    const history: HistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      role: "assistant" as const,
      content: `Decision ${i}: very long content to force truncation scenario.`,
      timestamp: Date.now() - i * 1000,
    }));

    const result = await engine.assemble({ strategy: baseStrategy, history });

    expect(result.systemPrompt).toContain("LONG-ONLY");
    expect(result.systemPrompt).toContain("Strategy Directives");
  });
});

// ---------------------------------------------------------------------------
// T011e: Quant feature vector survives truncation (Constitution II)
// ---------------------------------------------------------------------------

describe("ContextEngine quant feature preservation", () => {
  it("quant features are present even when history is truncated", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });

    const engine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "s1",
      tokenBudget: 400,
    });

    const history: HistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      role: "assistant" as const,
      content: `Decision ${i}: padded to force truncation.`,
      timestamp: Date.now() - i * 1000,
    }));

    const quantSnapshot = { rsi: 54.2, vwap: 42100.5, obImbalance: 0.67 };
    const result = await engine.assemble({ strategy: baseStrategy, history, quantSnapshot });

    expect(result.systemPrompt).toContain("Quantitative Features");
    expect(result.systemPrompt).toContain("rsi");
    expect(result.systemPrompt).toContain("54.2");
  });
});
