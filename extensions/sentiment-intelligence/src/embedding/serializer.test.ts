import { describe, it, expect } from "vitest";
import type { MacroContext } from "../schema/MacroSnapshot.js";
import type { SentimentSnapshot } from "../schema/SentimentSnapshot.js";
import { serializeSentiment, serializeMacro } from "./serializer.js";

const mockSnapshot: SentimentSnapshot = {
  symbol: "BTC",
  fearGreedScore: 72,
  fearGreedLabel: "greed",
  twitterScore: 0.65,
  tweetVolume: 12000,
  redditScore: 0.55,
  redditPostVolume: 800,
  fundingBias: "long",
  fundingRate: 0.0001,
  compositeScore: 0.7,
  lastUpdated: "2025-01-15T09:00:00.000Z",
};

const mockMacro: MacroContext = {
  dxy: 102.5,
  us10y: 4.2,
  m2Supply: 21000,
  oilPriceWti: 78.5,
  globalMarketCap: 2_500_000_000_000,
  btcDominance: 52.4,
  fomcNextDate: "2025-06-18",
  fomcLastAction: "hold",
  cpiLastReading: 3.2,
  cpiNextDate: "2025-07-11",
  regime: "neutral",
  lastUpdated: "2025-01-15T09:00:00.000Z",
};

describe("serializeSentiment", () => {
  it("returns a non-empty string containing key values", () => {
    const text = serializeSentiment(mockSnapshot);
    expect(text).toBeTruthy();
    expect(text).toContain("BTC");
    expect(text).toContain("greed");
    expect(text).toContain("72.0000");
    expect(text).toContain("long");
  });

  it("formats all numeric fields to 4 decimal places", () => {
    const text = serializeSentiment(mockSnapshot);
    expect(text).toContain("0.6500"); // twitterScore
    expect(text).toContain("0.5500"); // redditScore
    expect(text).toContain("0.7000"); // compositeScore
  });
});

describe("serializeMacro", () => {
  it("returns a non-empty string containing all field values", () => {
    const text = serializeMacro(mockMacro);
    expect(text).toBeTruthy();
    expect(text).toContain("102.5000");
    expect(text).toContain("4.2000");
    expect(text).toContain("hold");
    expect(text).toContain("2025-06-18");
    expect(text).toContain("neutral");
  });

  it("replaces null optional fields with N/A", () => {
    const nullMacro: MacroContext = {
      ...mockMacro,
      dxy: null,
      fomcNextDate: null,
      fomcLastAction: null,
    };
    const text = serializeMacro(nullMacro);
    expect(text).toContain("DXY: N/A");
    expect(text).toContain("FOMC next: N/A");
    expect(text).toContain("last action: N/A");
  });
});
