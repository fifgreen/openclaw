import { describe, it, expect, vi, beforeEach } from "vitest";
import { CryptoPanicFeed } from "./CryptoPanicFeed.js";

vi.mock("axios");
vi.mock("../news/classifier.js", () => ({
  classify: vi
    .fn()
    .mockResolvedValue({ impactClass: "other", sentiment: "neutral", confidence: 0.5 }),
}));
vi.mock("../news/deduplicator.js");
vi.mock("../db/queries.js", () => ({
  insertNewsEvent: vi.fn().mockResolvedValue(undefined),
  queryNewsEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}));

import axios from "axios";
import { insertNewsEvent } from "../db/queries.js";
import { isDuplicate } from "../news/deduplicator.js";

const mockPool = {} as import("pg").Pool;
const mockMemDir = { get: vi.fn(), set: vi.fn() };

function makeThreeResults() {
  return {
    data: {
      results: [
        {
          title: "Bitcoin hits $100k",
          url: "https://example.com/1",
          published_at: "2025-01-15T09:00:00Z",
          source: { title: "Source A" },
          currencies: [{ code: "BTC" }],
        },
        {
          title: "Ethereum surges after upgrade",
          url: "https://example.com/2",
          published_at: "2025-01-15T09:05:00Z",
          source: { title: "Source B" },
          currencies: [{ code: "ETH" }],
        },
        {
          title: "Bitcoin hits $100k", // duplicate headline
          url: "https://example.com/3",
          published_at: "2025-01-15T09:01:00Z",
          source: { title: "Source C" },
          currencies: [{ code: "BTC" }],
        },
      ],
    },
  };
}

describe("CryptoPanicFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(insertNewsEvent).mockResolvedValue(undefined);
    vi.mocked(axios.get).mockResolvedValue(makeThreeResults());
    // First two are NOT duplicates, third IS a duplicate
    vi.mocked(isDuplicate)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
  });

  it("inserts exactly 2 of 3 results when 1 is a duplicate", async () => {
    const feed = new CryptoPanicFeed({
      apiKey: "test-key",
      pool: mockPool,
      memDir: mockMemDir as never,
    });
    const count = await feed.poll(["BTC", "ETH"]);
    expect(count).toBe(2);
    expect(vi.mocked(insertNewsEvent)).toHaveBeenCalledTimes(2);
  });

  it("returns 0 and makes no HTTP call when API key is absent", async () => {
    const feed = new CryptoPanicFeed({ pool: mockPool, memDir: mockMemDir as never });
    const count = await feed.poll(["BTC"]);
    expect(count).toBe(0);
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
  });

  it("isDuplicate called for each result", async () => {
    const feed = new CryptoPanicFeed({
      apiKey: "key",
      pool: mockPool,
      memDir: mockMemDir as never,
    });
    await feed.poll(["BTC", "ETH"]);
    expect(vi.mocked(isDuplicate)).toHaveBeenCalledTimes(3);
  });
});
