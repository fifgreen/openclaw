import { describe, it, expect, vi } from "vitest";
import { isDuplicate } from "./deduplicator.js";

function makePool(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as import("pg").Pool;
}

describe("isDuplicate", () => {
  it("returns true when pool finds a matching row", async () => {
    const pool = makePool([{ found: 1 }]);
    const result = await isDuplicate("Bitcoin hits all-time high!!", "2025-01-15T09:02:00Z", pool);
    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("date_trunc('5 minutes', published_at)"),
      expect.arrayContaining(["bitcoin hits alltime high"]),
    );
  });

  it("returns false when pool returns no rows", async () => {
    const pool = makePool([]);
    const result = await isDuplicate("New DeFi protocol launches", "2025-01-15T09:07:00Z", pool);
    expect(result).toBe(false);
  });

  it("different 5-min bucket for same headline passes different bucket param", async () => {
    const pool = makePool([]);
    // 09:02 and 09:08 are in different 5-min buckets
    await isDuplicate("Same headline", "2025-01-15T09:02:00Z", pool);
    const call1 = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    await isDuplicate("Same headline", "2025-01-15T09:08:00Z", pool);
    const call2 = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1];
    // Bucket timestamps should differ
    expect(call1[1][1]).not.toBe(call2[1][1]);
  });
});
