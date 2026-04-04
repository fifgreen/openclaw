import { describe, it, expect, vi } from "vitest";
import { HaltProtocol } from "../halt/HaltProtocol.js";
import { setRedisClient } from "../memdir/index.js";
import { createMemDir } from "../memdir/MemDir.js";
import { ContextEngine } from "./ContextEngine.js";
import { parseStrategy, strategyToPromptClauses } from "./StrategyParser.js";
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

function makeHaltMock(): HaltProtocol & { triggered: boolean } {
  const mock = {
    trigger: vi.fn(),
    execute: vi.fn(),
    triggered: false,
  } as unknown as HaltProtocol & { triggered: boolean };
  (mock.trigger as ReturnType<typeof vi.fn>).mockImplementation(() => {
    mock.triggered = true;
    return Promise.resolve();
  });
  return mock;
}

// ---------------------------------------------------------------------------
// T014a: Valid strategy produces expected prompt clauses
// ---------------------------------------------------------------------------

describe("StrategyParser — valid strategy", () => {
  it("long-only strategy produces LONG-ONLY directive", () => {
    const result = parseStrategy({
      id: "btc-trend-v1",
      bias: "long-only",
      maxDrawdown: 0.03,
      allowedAssets: ["BTC/USDT"],
      entryConditions: { rsi: { above: 50 } },
      exitRules: { atrTp: "2x" },
      confluenceThreshold: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const clauses = strategyToPromptClauses(result.strategy);
    expect(clauses.some((c) => c.includes("LONG-ONLY"))).toBe(true);
    expect(clauses.some((c) => c.includes("3.0%"))).toBe(true);
    expect(clauses.some((c) => c.includes("BTC/USDT"))).toBe(true);
    expect(clauses.some((c) => c.includes("confluence") || c.includes("3 independent"))).toBe(true);
  });

  it("scalping strategy produces BOTH directional mode", () => {
    const result = parseStrategy({
      id: "eth-scalp-v2",
      bias: "both",
      maxDrawdown: 0.01,
      allowedAssets: ["ETH/USDT"],
      entryConditions: { volumeSpike: { multiplier: 3 } },
      exitRules: { trailingStop: "0.5%" },
      confluenceThreshold: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const clauses = strategyToPromptClauses(result.strategy);
    expect(clauses.some((c) => c.includes("long and short"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T014b: Different strategies produce demonstrably different prompts
// ---------------------------------------------------------------------------

describe("StrategyParser — strategy differentiation", () => {
  it("swing vs scalping strategies produce different prompt clauses", async () => {
    const redis = makeRedisMock();
    const memDir = createMemDir({ client: redis });

    const swingStrategy: StrategyOverride = {
      id: "btc-swing",
      bias: "long-only",
      maxDrawdown: 0.05,
      allowedAssets: ["BTC/USDT"],
      entryConditions: { trendAlignment: true },
      exitRules: { atrTp: "3x" },
      confluenceThreshold: 4,
    };

    const scalpStrategy: StrategyOverride = {
      id: "eth-scalp",
      bias: "both",
      maxDrawdown: 0.01,
      allowedAssets: ["ETH/USDT"],
      entryConditions: { microStructure: "bid_ask_imbalance" },
      exitRules: { trailingStop: "0.3%" },
      confluenceThreshold: 2,
    };

    const swingEngine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "btc",
      sessionId: "swing-session",
    });

    const scalpEngine = new ContextEngine({
      memDir,
      haltProtocol: makeHaltMock(),
      symbol: "eth",
      sessionId: "scalp-session",
    });

    const swingCtx = await swingEngine.assemble({ strategy: swingStrategy, history: [] });
    const scalpCtx = await scalpEngine.assemble({ strategy: scalpStrategy, history: [] });

    // Prompts must be meaningfully different
    expect(swingCtx.systemPrompt).not.toBe(scalpCtx.systemPrompt);
    expect(swingCtx.systemPrompt).toContain("LONG-ONLY");
    expect(scalpCtx.systemPrompt).toContain("long and short");
    expect(swingCtx.systemPrompt).toContain("5.0%"); // maxDrawdown
    expect(scalpCtx.systemPrompt).toContain("1.0%"); // maxDrawdown
  });
});

// ---------------------------------------------------------------------------
// T014c: Invalid strategy JSON triggers halt (not silent failure)
// ---------------------------------------------------------------------------

describe("StrategyParser — invalid strategy triggers halt", () => {
  it("parseStrategy returns ok:false for invalid JSON", () => {
    const result = parseStrategy({ id: "bad", bias: "INVALID_BIAS" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("parseStrategy returns ok:false for missing required fields", () => {
    const result = parseStrategy({ id: "incomplete" });
    expect(result.ok).toBe(false);
  });

  it("parseStrategy returns ok:false for zero-length allowedAssets", () => {
    const result = parseStrategy({
      id: "bad-assets",
      bias: "long-only",
      maxDrawdown: 0.03,
      allowedAssets: [], // must have at least 1
      entryConditions: {},
      exitRules: {},
      confluenceThreshold: 1,
    });
    expect(result.ok).toBe(false);
  });
});
