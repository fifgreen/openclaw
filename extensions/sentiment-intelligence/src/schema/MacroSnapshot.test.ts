import { describe, it, expect } from "vitest";
import { MacroContextSchema } from "./MacroSnapshot.js";

const valid = {
  dxy: 103.5,
  us10y: 4.2,
  m2Supply: 21000,
  oilPriceWti: 82.5,
  globalMarketCap: 2400000000000,
  btcDominance: 52.3,
  fomcNextDate: "2026-05-07",
  fomcLastAction: "hold",
  cpiLastReading: 3.1,
  cpiNextDate: "2026-04-10",
  regime: "neutral",
  lastUpdated: "2026-04-05T09:00:00.000Z",
};

describe("MacroContextSchema", () => {
  it("parses a valid macro context", () => {
    expect(MacroContextSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts nullable fields as null", () => {
    const withNulls = {
      ...valid,
      dxy: null,
      fomcNextDate: null,
      fomcLastAction: null,
      cpiLastReading: null,
      cpiNextDate: null,
    };
    expect(MacroContextSchema.safeParse(withNulls).success).toBe(true);
  });

  it("rejects invalid regime value", () => {
    const result = MacroContextSchema.safeParse({ ...valid, regime: "bearish" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid fomcLastAction", () => {
    const result = MacroContextSchema.safeParse({ ...valid, fomcLastAction: "pause" });
    expect(result.success).toBe(false);
  });
});
