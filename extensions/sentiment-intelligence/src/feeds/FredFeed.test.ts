import { describe, it, expect, vi, beforeEach } from "vitest";
import { FredFeed } from "./FredFeed.js";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

import axios from "axios";

function fredResponse(value: string) {
  return { data: { observations: [{ value, date: "2026-04-04" }] } };
}

describe("FredFeed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("populates all fields when all series return valid values", async () => {
    const cmcResponse = {
      data: {
        data: {
          quote: { USD: { total_market_cap: 2_400_000_000_000, btc_dominance: 52.3 } },
        },
      },
    };
    (axios.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fredResponse("103.5")) // dxy
      .mockResolvedValueOnce(fredResponse("4.2")) // us10y
      .mockResolvedValueOnce(fredResponse("21000")) // m2Supply
      .mockResolvedValueOnce(fredResponse("82.5")) // oilPriceWti
      .mockResolvedValueOnce(cmcResponse); // CMC

    const feed = new FredFeed({ fredApiKey: "test", coinMarketCapApiKey: "test-cmc" });
    const result = await feed.poll();

    expect(result.dxy).toBeCloseTo(103.5);
    expect(result.us10y).toBeCloseTo(4.2);
    expect(result.m2Supply).toBeCloseTo(21000);
    expect(result.oilPriceWti).toBeCloseTo(82.5);
  });

  it("sets field to null when FRED returns '.' placeholder", async () => {
    (axios.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(fredResponse(".")) // dxy = missing
      .mockResolvedValueOnce(fredResponse("4.2"))
      .mockResolvedValueOnce(fredResponse("21000"))
      .mockResolvedValueOnce(fredResponse("82.5"));

    const feed = new FredFeed({ fredApiKey: "test" });
    const result = await feed.poll();

    expect(result.dxy).toBeNull();
    expect(result.us10y).toBeCloseTo(4.2); // others still populated
    expect(result.globalMarketCap).toBeNull(); // no CMC key
  });

  it("warns and sets CMC fields to null when coinMarketCapApiKey absent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue(fredResponse("100"));

    const feed = new FredFeed({ fredApiKey: "test" });
    const result = await feed.poll();

    expect(result.globalMarketCap).toBeNull();
    expect(result.btcDominance).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("coinMarketCapApiKey"));
    warnSpy.mockRestore();
  });
});
