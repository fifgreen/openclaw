import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkFeeds } from "./HealthMonitor.js";

vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(),
}));
vi.mock("bullmq");

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockMemDir = { get: mockGet, set: mockSet };
const mockAlert = vi.fn();

function makeEntry(lastSuccessfulPoll: string, isStale: boolean) {
  return { value: { lastSuccessfulPoll, isStale } };
}

describe("checkFeeds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it("marks feed stale and calls alert when last poll > 2× interval ago", async () => {
    const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1_000).toISOString();
    // Return stale=false initially (was fresh), last poll 9h ago (> 2×4h)
    mockGet.mockImplementation(({ symbol }: { symbol: string }) => {
      if (symbol === "fear_greed") {
        return Promise.resolve(makeEntry(nineHoursAgo, false));
      }
      return Promise.resolve(makeEntry(new Date().toISOString(), false));
    });

    await checkFeeds(mockMemDir as never, "alert-channel", mockAlert);

    expect(mockAlert).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("fear_greed") }),
    );
    expect(mockSet).toHaveBeenCalledWith(
      { key: "sentiment_health", symbol: "fear_greed" },
      expect.objectContaining({ isStale: true }),
      expect.anything(),
    );
  });

  it("logs info when stale feed recovers (stale → fresh)", async () => {
    const recentPoll = new Date().toISOString();
    // Was stale, now fresh
    mockGet.mockImplementation(({ symbol }: { symbol: string }) => {
      if (symbol === "fear_greed") {
        return Promise.resolve(makeEntry(recentPoll, true));
      }
      return Promise.resolve(makeEntry(new Date().toISOString(), false));
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(vi.fn());

    await checkFeeds(mockMemDir as never, undefined, undefined);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("recovered"));
    infoSpy.mockRestore();
  });

  it("immediately marks feed stale when no health key exists", async () => {
    mockGet.mockResolvedValue(null);

    await checkFeeds(mockMemDir as never, "ch", mockAlert);

    // All 5 feeds have no record → all marked stale
    expect(mockAlert).toHaveBeenCalledTimes(5);
    expect(mockSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isStale: true }),
      expect.anything(),
    );
  });
});
