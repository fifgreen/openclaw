/**
 * Integration tests T039–T042: end-to-end pipeline smoke tests.
 * All external I/O is mocked; an in-memory MemDir stub allows data to flow
 * through multiple components without Redis or TimescaleDB.
 */

import axios from "axios";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as queriesMod from "../src/db/queries.js";
import * as dedupMod from "../src/news/deduplicator.js";

// ---------------------------------------------------------------------------
// Top-level vi.mock declarations (hoisted by Vitest before any imports)
// ---------------------------------------------------------------------------

vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(),
}));

vi.mock("../src/db/queries.js", () => ({
  upsertMacroSnapshot: vi.fn().mockResolvedValue(undefined),
  queryLatestMacroSnapshot: vi.fn().mockResolvedValue([]),
  insertSentimentSnapshot: vi.fn().mockResolvedValue(undefined),
  insertNewsEvent: vi.fn().mockResolvedValue(undefined),
  queryNewsEvents: vi.fn().mockResolvedValue([]),
  upsertFeedAccuracy: vi.fn().mockResolvedValue(undefined),
  queryFeedAccuracy: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/news/deduplicator.js", () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/news/classifier.js", () => ({
  classify: vi.fn().mockResolvedValue({
    impactClass: "regulatory",
    sentiment: "positive",
    confidence: 0.9,
  }),
}));

vi.mock("bullmq");

// ---------------------------------------------------------------------------
// In-memory MemDir stub — works without Redis
// ---------------------------------------------------------------------------

type MemEntry = { value: unknown };

function makeMemDir() {
  const store = new Map<string, MemEntry>();

  function storeKey(opts: { key: string; symbol: string }): string {
    return `${opts.symbol}::${opts.key}`;
  }

  return {
    async get(opts: { key: string; symbol: string }): Promise<MemEntry | null> {
      return store.get(storeKey(opts)) ?? null;
    },
    async set(
      opts: { key: string; symbol: string },
      value: unknown,
      _meta?: unknown,
    ): Promise<void> {
      store.set(storeKey(opts), { value });
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal pool stub — no real Postgres
// ---------------------------------------------------------------------------

function makePool() {
  return {
    async query(_sql: string, _params: unknown[] = []) {
      return { rows: [], rowCount: 0 };
    },
  };
}

// ===========================================================================
// T039 — Fear & Greed → get_sentiment pipeline
// ===========================================================================

describe("T039 — Fear & Greed → get_sentiment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes fear_greed subfeed and compositeScore to MemDir, getSentiment returns correct data", async () => {
    const memDir = makeMemDir();
    const pool = makePool();

    // Pre-populate reddit and twitter subfeeds so aggregator has non-stale data
    const now = new Date().toISOString();
    await memDir.set(
      { key: "sentiment_subfeed_reddit", symbol: "BTC" },
      { score: 0.6, postVolume: 100, lastUpdated: now },
    );
    await memDir.set(
      { key: "sentiment_subfeed_twitter", symbol: "BTC" },
      { score: 0.5, postVolume: 0, lastUpdated: now },
    );

    // Mock axios to return Fear & Greed = 72 (Greed)
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { data: [{ value: "72", value_classification: "Greed" }] },
    });

    const { FearGreedFeed } = await import("../src/feeds/FearGreedFeed.js");
    const { aggregate } = await import("../src/sentiment/aggregator.js");
    const { getSentiment } = await import("../src/tools/get-sentiment.js");

    // 1. Poll Fear & Greed feed
    const feed = new FearGreedFeed({ memDir: memDir as never });
    const pollResult = await feed.poll();

    expect(pollResult.score).toBeCloseTo(0.72);
    expect(pollResult.label).toBe("greed");

    // 2. Fear & Greed subfeed should be in MemDir
    const fgEntry = await memDir.get({ key: "sentiment_subfeed_fear_greed", symbol: "*" });
    expect(fgEntry).not.toBeNull();
    expect((fgEntry!.value as Record<string, unknown>)["score"]).toBeCloseTo(0.72);
    expect((fgEntry!.value as Record<string, unknown>)["label"]).toBe("greed");

    // 3. Run sentiment aggregator
    const snapshot = await aggregate("BTC", memDir as never, pool as never);

    expect(snapshot.fearGreedScore).toBeCloseTo(0.72);
    expect(snapshot.fearGreedLabel).toBe("greed");
    expect(snapshot.redditScore).toBeCloseTo(0.6);
    expect(snapshot.compositeScore).toBeGreaterThan(0);
    expect(snapshot.compositeScore).toBeLessThanOrEqual(1);

    // 4. Composite should be in MemDir
    const compositeEntry = await memDir.get({ key: "sentiment_composite", symbol: "BTC" });
    expect(compositeEntry).not.toBeNull();
    expect((compositeEntry!.value as Record<string, unknown>)["compositeScore"]).toBeCloseTo(
      snapshot.compositeScore,
    );

    // 5. getSentiment reads composite from MemDir
    const result = await getSentiment("BTC", memDir as never);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.fearGreedScore).toBeCloseTo(0.72);
      expect(result.compositeScore).toBeGreaterThan(0);
    }
  }, 5_000);
});

// ===========================================================================
// T040 — FRED → get_macro_context pipeline
// ===========================================================================

describe("T040 — FRED → get_macro_context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("FredFeed.poll() returns FRED values; buildMacroContext writes to MemDir; getMacroContext returns correct macro within 200ms", async () => {
    const memDir = makeMemDir();
    const pool = makePool();

    const mockFredObs = (value: string) => ({
      data: { observations: [{ value, date: "2025-01-01" }] },
    });

    vi.mocked(axios.get)
      .mockResolvedValueOnce(mockFredObs("101.5")) // DXY
      .mockResolvedValueOnce(mockFredObs("4.5")) // US10Y
      .mockResolvedValueOnce(mockFredObs("21500")) // M2SL
      .mockResolvedValueOnce(mockFredObs("78.2")); // Oil

    // queryLatestMacroSnapshot returns the rows as they'd appear after upserts
    vi.mocked(queriesMod.queryLatestMacroSnapshot).mockResolvedValue([
      { series_id: "DTWEXBGS", value: 101.5, unit: "index", effective_date: "2025-01-01" },
      { series_id: "DGS10", value: 4.5, unit: "pct", effective_date: "2025-01-01" },
      { series_id: "M2SL", value: 21500, unit: "billions_usd", effective_date: "2025-01-01" },
      { series_id: "DCOILWTICO", value: 78.2, unit: "usd_bbl", effective_date: "2025-01-01" },
    ] as never);

    const { FredFeed } = await import("../src/feeds/FredFeed.js");
    const { buildMacroContext } = await import("../src/macro/MacroScheduler.js");
    const { getMacroContext } = await import("../src/tools/get-macro-context.js");

    // 1. Poll FRED (returns values; DB upserts happen in MacroScheduler worker, not here)
    const fredFeed = new FredFeed({ fredApiKey: "test-key" });
    const result = await fredFeed.poll();

    expect(result.dxy).toBeCloseTo(101.5);
    expect(result.us10y).toBeCloseTo(4.5);
    expect(result.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 2. buildMacroContext reads from DB (via mocked queryLatestMacroSnapshot) and writes to MemDir
    const start = Date.now();
    const macro = await buildMacroContext(pool as never, memDir as never);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(macro.dxy).toBeCloseTo(101.5);
    expect(macro.us10y).toBeCloseTo(4.5);
    expect(["risk_off", "neutral", "risk_on", "uncertain"]).toContain(macro.regime);

    // 3. MemDir has macro_snapshot written
    const macroEntry = await memDir.get({ key: "macro_snapshot", symbol: "*" });
    expect(macroEntry).not.toBeNull();
    expect((macroEntry!.value as Record<string, unknown>)["dxy"]).toBeCloseTo(101.5);

    // 4. getMacroContext reads from MemDir
    const ctxResult = await getMacroContext(memDir as never);
    expect("error" in ctxResult).toBe(false);
    if (!("error" in ctxResult)) {
      expect(ctxResult.dxy).toBeCloseTo(101.5);
      expect(ctxResult.regime).toBeTruthy();
    }
  }, 5_000);
});

// ===========================================================================
// T041 — CryptoPanic → get_news_events pipeline
// ===========================================================================

describe("T041 — CryptoPanic → get_news_events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates 3 results (1 dup); insertNewsEvent called twice; getNewsEvents returns 2 items", async () => {
    const memDir = makeMemDir();
    const pool = makePool();

    const threePosts = {
      results: [
        {
          title: "Bitcoin ETF approved by SEC",
          url: "https://example.com/1",
          published_at: "2025-01-15T10:00:00Z",
          source: { title: "CoinDesk" },
          currencies: [{ code: "BTC" }],
        },
        {
          title: "Ethereum upgrade goes live",
          url: "https://example.com/2",
          published_at: "2025-01-15T09:00:00Z",
          source: { title: "CoinDesk" },
          currencies: [{ code: "BTC" }, { code: "ETH" }],
        },
        {
          title: "Bitcoin ETF approved by SEC", // duplicate
          url: "https://example.com/3",
          published_at: "2025-01-15T10:01:00Z",
          source: { title: "CoinTelegraph" },
          currencies: [{ code: "BTC" }],
        },
      ],
    };

    vi.mocked(axios.get).mockResolvedValueOnce({ data: threePosts });

    // First two unique; third is duplicate
    vi.mocked(dedupMod.isDuplicate)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    vi.mocked(queriesMod.queryNewsEvents).mockResolvedValue([
      {
        id: 1,
        headline: "Bitcoin ETF approved by SEC",
        source: "CoinDesk",
        url: "https://example.com/1",
        sentiment: "positive",
        impact_class: "regulatory",
        relevance_score: 0.9,
        symbols: ["BTC"],
        published_at: "2025-01-15T10:00:00Z",
      },
      {
        id: 2,
        headline: "Ethereum upgrade goes live",
        source: "CoinDesk",
        url: "https://example.com/2",
        sentiment: "positive",
        impact_class: "technical",
        relevance_score: 0.9,
        symbols: ["BTC", "ETH"],
        published_at: "2025-01-15T09:00:00Z",
      },
    ] as never);

    const { CryptoPanicFeed } = await import("../src/feeds/CryptoPanicFeed.js");
    const { getNewsEvents } = await import("../src/tools/get-news-events.js");

    // 1. Poll CryptoPanic
    const feed = new CryptoPanicFeed({
      apiKey: "test-api-key",
      pool: pool as never,
      memDir: memDir as never,
    });

    const insertedCount = await feed.poll(["BTC"]);
    expect(insertedCount).toBe(2);

    // 2. isDuplicate called once per result (3×)
    expect(dedupMod.isDuplicate).toHaveBeenCalledTimes(3);

    // 3. insertNewsEvent called exactly twice (duplicate skipped)
    expect(queriesMod.insertNewsEvent).toHaveBeenCalledTimes(2);

    // 4. getNewsEvents returns 2 items
    const events = await getNewsEvents(pool as never, "BTC", 5);
    expect(events).toHaveLength(2);

    // 5. queryNewsEvents called with symbol filter
    expect(queriesMod.queryNewsEvents).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ symbol: "BTC" }),
    );

    // 6. Returned events have correct shape
    const [first] = events;
    expect(first!.symbols).toContain("BTC");
    expect(["regulatory", "technical", "hack", "other"]).toContain(first!.impactClass);
    expect(["positive", "negative", "neutral"]).toContain(first!.sentiment);
  }, 5_000);
});

// ===========================================================================
// T042 — HealthMonitor stale feed
// ===========================================================================

describe("T042 — HealthMonitor stale feed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transitions fear_greed fresh → stale: emits warn + calls alert", async () => {
    const memDir = makeMemDir();
    const alertFn = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1_000).toISOString();

    // fear_greed was fresh but last polled 10h ago (> 2×4h threshold → stale)
    await memDir.set(
      { key: "sentiment_health", symbol: "fear_greed" },
      { lastSuccessfulPoll: tenHoursAgo, isStale: false },
    );
    // All other feeds healthy
    const now = new Date().toISOString();
    for (const feed of ["twitter", "reddit", "cryptopanic", "fred"]) {
      await memDir.set(
        { key: "sentiment_health", symbol: feed },
        { lastSuccessfulPoll: now, isStale: false },
      );
    }

    const { checkFeeds } = await import("../src/health/HealthMonitor.js");
    await checkFeeds(memDir as never, "test-channel", alertFn);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fear_greed"));
    expect(alertFn).toHaveBeenCalledTimes(1);
    expect(alertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "test-channel",
        message: expect.stringContaining("fear_greed"),
      }),
    );

    // MemDir now shows isStale: true
    const entry = await memDir.get({ key: "sentiment_health", symbol: "fear_greed" });
    expect((entry!.value as Record<string, unknown>)["isStale"]).toBe(true);

    warnSpy.mockRestore();
  }, 5_000);

  it("transitions fear_greed stale → fresh: emits info log, no alert", async () => {
    const memDir = makeMemDir();
    const alertFn = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(vi.fn());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    const recentPoll = new Date().toISOString();

    // fear_greed was stale but just recovered (recent poll)
    await memDir.set(
      { key: "sentiment_health", symbol: "fear_greed" },
      { lastSuccessfulPoll: recentPoll, isStale: true },
    );
    for (const feed of ["twitter", "reddit", "cryptopanic", "fred"]) {
      await memDir.set(
        { key: "sentiment_health", symbol: feed },
        { lastSuccessfulPoll: recentPoll, isStale: false },
      );
    }

    const { checkFeeds } = await import("../src/health/HealthMonitor.js");
    await checkFeeds(memDir as never, undefined, alertFn);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("recovered"));
    expect(alertFn).not.toHaveBeenCalled();

    // MemDir now shows isStale: false
    const entry = await memDir.get({ key: "sentiment_health", symbol: "fear_greed" });
    expect((entry!.value as Record<string, unknown>)["isStale"]).toBe(false);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  }, 5_000);
});
