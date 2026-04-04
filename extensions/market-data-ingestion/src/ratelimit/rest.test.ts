import { describe, it, expect, vi } from "vitest";

// Mock BullMQ before importing so the module under test uses the mock
vi.mock("bullmq", () => {
  return { Queue: vi.fn(), Worker: vi.fn() };
});

// We directly test the in-process fallback (TokenBucketQueue) path since
// real BullMQ/Redis is not available in unit tests.

describe("rateLimitedRest — in-process fallback (no Redis)", () => {
  it("resolves with the return value of fn", async () => {
    // Dynamically import after mocks are set up
    const { rateLimitedRest } = await import("./rest.js");
    const result = await rateLimitedRest("binance", async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from fn", async () => {
    const { rateLimitedRest } = await import("./rest.js");
    await expect(
      rateLimitedRest("bybit", async () => {
        throw new Error("exchange error");
      }),
    ).rejects.toThrow("exchange error");
  });

  it("resolves correctly for both exchanges", async () => {
    const { rateLimitedRest } = await import("./rest.js");
    const binanceResult = await rateLimitedRest("binance", async () => "binance-ok");
    const bybitResult = await rateLimitedRest("bybit", async () => "bybit-ok");
    expect(binanceResult).toBe("binance-ok");
    expect(bybitResult).toBe("bybit-ok");
  });

  it("quotaFraction: 0.5 does not break the fallback path", async () => {
    // With no Redis, the TokenBucketQueue is used; quotaFraction is informational
    // at the queue-creation level but the call still resolves correctly
    const { rateLimitedRest } = await import("./rest.js");
    const result = await rateLimitedRest("binance", async () => "half-rate", {
      quotaFraction: 0.5,
    });
    expect(result).toBe("half-rate");
  });
});

describe("RATE_CAPS", () => {
  it("binance cap is 960 RPM", async () => {
    const { RATE_CAPS } = await import("./queues.js");
    expect(RATE_CAPS.binance).toBe(960);
  });

  it("bybit cap is 480 RPM", async () => {
    const { RATE_CAPS } = await import("./queues.js");
    expect(RATE_CAPS.bybit).toBe(480);
  });
});
