import { describe, it, expect, vi, beforeEach } from "vitest";
import { FearGreedFeed } from "./FearGreedFeed.js";

// Mock axios
vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

// Mock createMemDir — returns a mock MemDir
const mockSet = vi.fn().mockResolvedValue(undefined);
const mockGet = vi.fn().mockResolvedValue(null);
vi.mock("@openclaw/trading-context/src/memdir/MemDir.js", () => ({
  createMemDir: vi.fn(() => ({ get: mockGet, set: mockSet })),
}));

import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";

function makeFeed(): FearGreedFeed {
  const memDir = createMemDir();
  return new FearGreedFeed({ memDir });
}

describe("FearGreedFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it("writes score to MemDir on valid response", async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        data: [{ value: "72", value_classification: "Greed" }],
      },
    });

    const feed = makeFeed();
    const result = await feed.poll();

    expect(result.score).toBeCloseTo(0.72);
    expect(result.label).toBe("greed");
    expect(mockSet).toHaveBeenCalledTimes(2); // subfeed + health
    const [firstCall] = mockSet.mock.calls;
    expect(firstCall?.[1]).toMatchObject({ score: expect.closeTo(0.72) });
  });

  it("rejects and throws on invalid payload", async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [] }, // empty array — fails min(1)
    });

    const feed = makeFeed();
    await expect(feed.poll()).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("clamps score above 1 and emits warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        data: [{ value: "110", value_classification: "Extreme Greed" }],
      },
    });

    const feed = makeFeed();
    const result = await feed.poll();

    expect(result.score).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("clamping"));
    warnSpy.mockRestore();
  });
});
