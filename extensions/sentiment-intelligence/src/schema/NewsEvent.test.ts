import { describe, it, expect } from "vitest";
import { NewsEventSchema } from "./NewsEvent.js";

const valid = {
  id: 1,
  headline: "Bitcoin ETF approved by SEC",
  source: "CryptoPanic",
  url: "https://example.com/news/1",
  sentiment: "positive",
  impactClass: "institutional",
  classificationConfidence: 0.9,
  symbols: ["BTC"],
  publishedAt: "2026-04-05T10:00:00.000Z",
};

describe("NewsEventSchema", () => {
  it("parses a valid news event", () => {
    expect(NewsEventSchema.safeParse(valid).success).toBe(true);
  });

  it("strips extra fields", () => {
    const result = NewsEventSchema.safeParse({ ...valid, extraField: "ignored" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("extraField");
    }
  });

  it("rejects invalid sentiment enum", () => {
    expect(NewsEventSchema.safeParse({ ...valid, sentiment: "bullish" }).success).toBe(false);
  });

  it("rejects invalid impactClass enum", () => {
    expect(NewsEventSchema.safeParse({ ...valid, impactClass: "unknown" }).success).toBe(false);
  });

  it("rejects non-integer id", () => {
    expect(NewsEventSchema.safeParse({ ...valid, id: 1.5 }).success).toBe(false);
  });
});
