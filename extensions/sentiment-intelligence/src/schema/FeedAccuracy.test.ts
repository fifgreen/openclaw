import { describe, it, expect } from "vitest";
import { FeedAccuracyReportSchema } from "./FeedAccuracy.js";

describe("FeedAccuracyReportSchema", () => {
  it("accepts null accuracy30d", () => {
    const result = FeedAccuracyReportSchema.safeParse({
      feeds: [
        {
          feedId: "fear_greed",
          lastSuccessfulPoll: "2026-04-05T10:00:00Z",
          isStale: false,
          accuracy30d: null,
          sampleCount: 0,
          weight: 1.0,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative weight", () => {
    const result = FeedAccuracyReportSchema.safeParse({
      feeds: [
        {
          feedId: "fear_greed",
          lastSuccessfulPoll: "2026-04-05T10:00:00Z",
          isStale: false,
          accuracy30d: 0.8,
          sampleCount: 15,
          weight: -0.1,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid report with multiple feeds", () => {
    const result = FeedAccuracyReportSchema.safeParse({
      feeds: [
        {
          feedId: "fear_greed",
          lastSuccessfulPoll: "2026-04-05T10:00:00Z",
          isStale: false,
          accuracy30d: 0.7,
          sampleCount: 12,
          weight: 1.2,
        },
        {
          feedId: "reddit",
          lastSuccessfulPoll: "2026-04-05T08:00:00Z",
          isStale: false,
          accuracy30d: null,
          sampleCount: 4,
          weight: 1.0,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
