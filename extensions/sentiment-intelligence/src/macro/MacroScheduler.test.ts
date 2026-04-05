import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMacroContext, registerMacroJobs } from "./MacroScheduler.js";

// Mock dependencies
vi.mock("axios");
vi.mock("../feeds/FredFeed.js");
vi.mock("../db/queries.js", () => ({
  upsertMacroSnapshot: vi.fn(),
  queryLatestMacroSnapshot: vi.fn(),
}));
vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(),
}));

import axios from "axios";
import { upsertMacroSnapshot, queryLatestMacroSnapshot } from "../db/queries.js";

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockMemDir = { set: mockSet, get: mockGet };
const mockPool = {} as import("pg").Pool;

function makeMockQueue() {
  return {
    add: vi.fn(),
    removeRepeatable: vi.fn(),
  };
}

function makeMockFredFeed(
  result: unknown = {
    dxy: 102.5,
    us10y: 4.2,
    m2Supply: 21000,
    oilPriceWti: 78,
    effectiveDate: "2025-01-01",
    globalMarketCap: null,
    btcDominance: null,
  },
) {
  return { poll: vi.fn().mockResolvedValue(result) };
}

describe("buildMacroContext", () => {
  beforeEach(() => {
    mockSet.mockReset();
    vi.mocked(queryLatestMacroSnapshot).mockReset();
  });

  it("classifies risk_off when DXY > 104 and US10Y > 4.5 and FOMC hike", async () => {
    vi.mocked(queryLatestMacroSnapshot).mockResolvedValue([
      { series_id: "DTWEXBGS", value: 105, unit: "", effective_date: "" },
      { series_id: "DGS10", value: 4.8, unit: "", effective_date: "" },
      { series_id: "fomcLastAction", value: 1, unit: "", effective_date: "" }, // hike
    ]);

    const macro = await buildMacroContext(mockPool, mockMemDir as never);

    expect(macro.regime).toBe("risk_off");
    expect(macro.dxy).toBe(105);
    expect(macro.us10y).toBe(4.8);
    expect(macro.fomcLastAction).toBe("hike");
    expect(mockSet).toHaveBeenCalledWith(
      { key: "macro_snapshot", symbol: "*" },
      expect.objectContaining({ regime: "risk_off" }),
      expect.objectContaining({ ttlMs: 86_400_000 }),
    );
  });

  it("sets regime to uncertain when fomcLastAction is missing", async () => {
    vi.mocked(queryLatestMacroSnapshot).mockResolvedValue([
      { series_id: "DTWEXBGS", value: 106, unit: "", effective_date: "" },
      { series_id: "DGS10", value: 5.0, unit: "", effective_date: "" },
      // no fomcLastAction
    ]);

    const macro = await buildMacroContext(mockPool, mockMemDir as never);

    expect(macro.regime).toBe("uncertain");
    expect(macro.fomcLastAction).toBeNull();
  });

  it("decodes date timestamps for fomcNextDate and cpiNextDate", async () => {
    const fomcDate = new Date("2025-06-18").getTime();
    const cpiDate = new Date("2025-06-12").getTime();
    vi.mocked(queryLatestMacroSnapshot).mockResolvedValue([
      { series_id: "fomcNextDate", value: fomcDate, unit: "", effective_date: "" },
      { series_id: "cpiNextDate", value: cpiDate, unit: "", effective_date: "" },
    ]);

    const macro = await buildMacroContext(mockPool, mockMemDir as never);

    expect(macro.fomcNextDate).toBe("2025-06-18");
    expect(macro.cpiNextDate).toBe("2025-06-12");
  });
});

describe("registerMacroJobs", () => {
  beforeEach(() => {
    mockSet.mockReset();
    mockGet.mockReset();
    vi.mocked(upsertMacroSnapshot).mockReset();
    vi.mocked(queryLatestMacroSnapshot).mockResolvedValue([]);
  });

  it("registers 4 repeatable jobs", async () => {
    const queue = makeMockQueue();
    const fredFeed = makeMockFredFeed();

    await registerMacroJobs({
      fredFeed: fredFeed as never,
      memDir: mockMemDir as never,
      pool: mockPool,
      queue: queue as never,
    });

    expect(queue.add).toHaveBeenCalledTimes(4);
    const jobNames = queue.add.mock.calls.map((c: unknown[]) => c[0]);
    expect(jobNames).toContain("fred-daily");
    expect(jobNames).toContain("fomc-weekly");
    expect(jobNames).toContain("cpi-weekly");
    expect(jobNames).toContain("macro-context-build");
  });

  it("handleJob fred-daily upserts FRED series and writes health", async () => {
    const queue = makeMockQueue();
    const fredFeed = makeMockFredFeed();

    const handle = await registerMacroJobs({
      fredFeed: fredFeed as never,
      memDir: mockMemDir as never,
      pool: mockPool,
      queue: queue as never,
    });

    await handle.handleJob("fred-daily");

    expect(vi.mocked(upsertMacroSnapshot)).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ series_id: "DTWEXBGS" }),
    );
    expect(mockSet).toHaveBeenCalledWith(
      { key: "sentiment_health", symbol: "fred" },
      expect.objectContaining({ isStale: false }),
      expect.anything(),
    );
  });

  it("handleJob fomc-weekly retains last MemDir state on scrape failure", async () => {
    const queue = makeMockQueue();
    const fredFeed = makeMockFredFeed();
    vi.mocked(axios.get).mockRejectedValue(new Error("network error"));
    mockGet.mockResolvedValue({
      value: {
        dxy: 100,
        us10y: 4.0,
        m2Supply: null,
        oilPriceWti: null,
        globalMarketCap: null,
        btcDominance: null,
        fomcNextDate: "2025-06-18",
        fomcLastAction: null,
        cpiLastReading: null,
        cpiNextDate: null,
        regime: "neutral",
        lastUpdated: "2025-01-01T00:00:00.000Z",
      },
    });

    const handle = await registerMacroJobs({
      fredFeed: fredFeed as never,
      memDir: mockMemDir as never,
      pool: mockPool,
      queue: queue as never,
    });

    await handle.handleJob("fomc-weekly");

    expect(mockSet).toHaveBeenCalledWith(
      { key: "macro_snapshot", symbol: "*" },
      expect.objectContaining({ fomcNextDate: null }),
      expect.anything(),
    );
  });

  it("cleanup removes all 4 repeatable jobs", async () => {
    const queue = makeMockQueue();
    const fredFeed = makeMockFredFeed();

    const handle = await registerMacroJobs({
      fredFeed: fredFeed as never,
      memDir: mockMemDir as never,
      pool: mockPool,
      queue: queue as never,
    });

    await handle.cleanup();

    expect(queue.removeRepeatable).toHaveBeenCalledTimes(4);
  });
});
