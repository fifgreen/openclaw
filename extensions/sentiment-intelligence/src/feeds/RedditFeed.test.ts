import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedditFeed } from "./RedditFeed.js";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

const mockSet = vi.fn().mockResolvedValue(undefined);
vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(() => ({ get: vi.fn(), set: mockSet })),
}));

import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";

function hotResponse(titles: string[]) {
  return {
    data: {
      data: {
        children: titles.map((title) => ({ data: { title, link_flair_text: null } })),
      },
    },
  };
}

function makeFeed(): RedditFeed {
  return new RedditFeed({ memDir: createMemDir() });
}

describe("RedditFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it("scores bullish posts above 0.5 when BTC mentioned", async () => {
    (axios.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(hotResponse(["BTC to the moon!", "BTC bull run rally"]))
      .mockResolvedValueOnce(hotResponse(["BTC ath incoming"]));

    const feed = makeFeed();
    const result = await feed.poll("BTC");

    expect(result.score).toBeGreaterThan(0.5);
    expect(result.postVolume).toBe(3);
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it("returns neutral score when symbol not mentioned", async () => {
    (axios.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(hotResponse(["ETH dominance rising"]))
      .mockResolvedValueOnce(hotResponse(["Ethereum looks strong"]));

    const feed = makeFeed();
    const result = await feed.poll("BTC");

    expect(result.score).toBe(0.5);
    expect(result.postVolume).toBe(0);
  });

  it("returns score 0.5 and postVolume 0 on empty responses", async () => {
    (axios.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(hotResponse([]))
      .mockResolvedValueOnce(hotResponse([]));

    const feed = makeFeed();
    const result = await feed.poll("BTC");

    expect(result.score).toBe(0.5);
    expect(result.postVolume).toBe(0);
  });
});
