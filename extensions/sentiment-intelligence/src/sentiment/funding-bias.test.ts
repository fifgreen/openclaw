import { describe, it, expect, vi } from "vitest";
import { deriveFundingBias } from "./funding-bias.js";

function makeMockMemDir(rateEntry: { rate: number; nextFundingAt: number } | null) {
  return {
    get: vi
      .fn()
      .mockResolvedValue(
        rateEntry === null
          ? null
          : { value: rateEntry, updatedAt: Date.now(), ttlMs: 8 * 60 * 60 * 1000, source: "test" },
      ),
    set: vi.fn(),
  };
}

describe("deriveFundingBias", () => {
  it("rate 0.00012 (0.012%) → long", async () => {
    const memDir = makeMockMemDir({ rate: 0.00012, nextFundingAt: Date.now() + 3600_000 });
    const result = await deriveFundingBias("BTC", memDir as never);
    expect(result.bias).toBe("long");
    expect(result.rate).toBe(0.00012);
  });

  it("rate -0.00005 (-0.005%) → short", async () => {
    const memDir = makeMockMemDir({ rate: -0.00005, nextFundingAt: Date.now() + 3600_000 });
    const result = await deriveFundingBias("BTC", memDir as never);
    expect(result.bias).toBe("short");
  });

  it("absent key → neutral, rate 0", async () => {
    const memDir = makeMockMemDir(null);
    const result = await deriveFundingBias("BTC", memDir as never);
    expect(result.bias).toBe("neutral");
    expect(result.rate).toBe(0);
  });

  it("magnitude exactly 0.00001 → neutral", async () => {
    const memDir = makeMockMemDir({ rate: 0.00001, nextFundingAt: Date.now() + 3600_000 });
    const result = await deriveFundingBias("BTC", memDir as never);
    expect(result.bias).toBe("neutral");
  });
});
