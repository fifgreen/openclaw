import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";
import type { Pool } from "pg";
import { z } from "zod";
import { insertNewsEvent } from "../db/queries.js";
import { classify, type ClassifierOptions } from "../news/classifier.js";
import { isDuplicate } from "../news/deduplicator.js";

// Response schema for CryptoPanic free API
const CryptoPanicResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  published_at: z.string(),
  source: z.object({ title: z.string() }),
  currencies: z.array(z.object({ code: z.string() })).optional(),
});

const CryptoPanicResponseSchema = z.object({
  results: z.array(CryptoPanicResultSchema),
});

const CRYPTOPANIC_API_URL =
  "https://cryptopanic.com/api/free/v1/posts/?auth_token={token}&public=true";

export interface CryptoPanicFeedOptions {
  apiKey?: string;
  pool: Pool;
  memDir: ReturnType<typeof createMemDir>;
  classifierOpts?: ClassifierOptions;
}

export class CryptoPanicFeed {
  readonly feedId = "cryptopanic";
  readonly schedule = "*/30 * * * *";

  private readonly pool: Pool;
  private readonly memDir: ReturnType<typeof createMemDir>;
  private readonly apiKey: string | undefined;
  private readonly classifierOpts: ClassifierOptions;

  constructor(opts: CryptoPanicFeedOptions) {
    this.pool = opts.pool;
    this.memDir = opts.memDir;
    this.apiKey = opts.apiKey;
    this.classifierOpts = opts.classifierOpts ?? {};
  }

  /**
   * Polls CryptoPanic for news posts, deduplicates, classifies, and inserts.
   * Returns inserted event count (0 if API key missing).
   */
  async poll(symbols: string[]): Promise<number> {
    if (!this.apiKey) {
      console.warn("[CryptoPanicFeed] No API key configured — skipping poll");
      return 0;
    }

    const url = CRYPTOPANIC_API_URL.replace("{token}", this.apiKey);
    const res = await axios.get(url, { timeout: 15_000 });
    const parsed = CryptoPanicResponseSchema.safeParse(res.data);
    if (!parsed.success) {
      console.warn("[CryptoPanicFeed] Unexpected API response shape:", parsed.error.message);
      return 0;
    }

    let inserted = 0;
    for (const item of parsed.data.results) {
      // Filter by requested symbols if currencies are present
      const itemSymbols: string[] = item.currencies?.map((c) => c.code) ?? [];
      const relevant =
        symbols.length === 0 ||
        itemSymbols.length === 0 || // include untagged items
        itemSymbols.some((s) => symbols.includes(s));
      if (!relevant) continue;

      // Dedup check
      const dup = await isDuplicate(item.title, item.published_at, this.pool);
      if (dup) continue;

      // Classify
      const { impactClass, sentiment, confidence } = await classify(
        item.title,
        this.classifierOpts,
      );

      await insertNewsEvent(this.pool, {
        headline: item.title,
        source: item.source.title,
        symbols: itemSymbols.length > 0 ? itemSymbols : symbols,
        sentiment,
        impact_class: impactClass,
        relevance_score: confidence,
        url: item.url,
        published_at: item.published_at,
      });
      inserted++;
    }

    // Write health update after successful poll
    await this.memDir.set(
      { key: "sentiment_health", symbol: "cryptopanic" },
      { lastSuccessfulPoll: new Date().toISOString(), isStale: false },
      { ttlMs: null, source: "CryptoPanicFeed" },
    );

    return inserted;
  }
}
