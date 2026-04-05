import { describe, it, expect, vi, beforeEach } from "vitest";
import { TwitterFeed } from "./TwitterFeed.js";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

const mockSet = vi.fn().mockResolvedValue(undefined);
vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(() => ({ get: vi.fn(), set: mockSet })),
}));

import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";

function makeFeed(bearerToken?: string): TwitterFeed {
  return new TwitterFeed({ memDir: createMemDir(), bearerToken });
}

describe("TwitterFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it("returns neutral stub when no bearer token configured", async () => {
    const feed = makeFeed(); // no token
    const result = await feed.poll("BTC");

    expect(result.score).toBe(0.5);
    expect(result.tweetVolume).toBe(0);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("disables feed and returns stub on 429", async () => {
    const error = Object.assign(new Error("rate limited"), {
      response: { status: 429 },
    });
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    const feed = makeFeed("test-token");
    const result = await feed.poll("BTC");

    expect(result.score).toBe(0.5);
    expect(result.tweetVolume).toBe(0);

    // Subsequent poll — feed is disabled, no network call
    const result2 = await feed.poll("BTC");
    expect(result2.score).toBe(0.5);
    expect(axios.get).toHaveBeenCalledTimes(1); // only the first attempt
  });

  it("derives score from bullish keywords", async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        data: [
          { text: "BTC moon bull run rally" },
          { text: "bitcoin ath incoming" },
          { text: "BTC crash rekt" },
        ],
      },
    });

    const feed = makeFeed("test-token");
    const result = await feed.poll("BTC");

    // 2 bullish, 1 bearish — composite should be > 0.5
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.tweetVolume).toBe(3);
    expect(mockSet).toHaveBeenCalledTimes(2); // subfeed + health
  });
});
