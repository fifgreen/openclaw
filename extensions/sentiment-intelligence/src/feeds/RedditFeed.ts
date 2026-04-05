import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";
import { z } from "zod";
import type { IFeed } from "./types.js";

const BULLISH_TERMS = ["bull", "moon", "pump", "rally", "ath", "long"];
const BEARISH_TERMS = ["bear", "dump", "crash", "short", "rekt", "capitulation"];

const SUBREDDITS = ["CryptoCurrency", "Bitcoin"];

const HotResponseSchema = z.object({
  data: z.object({
    children: z.array(
      z.object({
        data: z.object({
          title: z.string(),
          link_flair_text: z.string().nullable().optional(),
        }),
      }),
    ),
  }),
});

/** Score a piece of text into [0,1]. 0 = bearish, 0.5 = neutral, 1 = bullish. */
function scoreText(text: string): number {
  const lower = text.toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const term of BULLISH_TERMS) {
    if (lower.includes(term)) bull++;
  }
  for (const term of BEARISH_TERMS) {
    if (lower.includes(term)) bear++;
  }
  if (bull === 0 && bear === 0) return 0.5;
  return Math.max(0, Math.min(1, ((bull - bear) / (bull + bear)) * 0.5 + 0.5));
}

/** Returns true if symbol is mentioned in the text (case-insensitive). */
function mentionsSymbol(text: string, symbol: string): boolean {
  return text.toLowerCase().includes(symbol.toLowerCase());
}

export interface RedditFeedOptions {
  memDir: ReturnType<typeof createMemDir>;
}

export type RedditPollResult = {
  score: number;
  postVolume: number;
  lastUpdated: string;
};

export class RedditFeed implements IFeed<RedditPollResult> {
  readonly feedId = "reddit";
  readonly schedule = "0 */4 * * *";

  private readonly memDir: ReturnType<typeof createMemDir>;

  constructor(opts: RedditFeedOptions) {
    this.memDir = opts.memDir;
  }

  async poll(symbol: string): Promise<RedditPollResult> {
    const responses = await Promise.all(
      SUBREDDITS.map((sub) =>
        axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=25`, {
          timeout: 10_000,
          headers: { "User-Agent": "openclaw-sentiment-bot/1.0" },
        }),
      ),
    );

    const scores: number[] = [];
    for (const res of responses) {
      const parsed = HotResponseSchema.parse(res.data);
      for (const post of parsed.data.children) {
        const { title, link_flair_text } = post.data;
        if (
          mentionsSymbol(title, symbol) ||
          (link_flair_text != null && mentionsSymbol(link_flair_text, symbol))
        ) {
          scores.push(scoreText(title));
        }
      }
    }

    const result: RedditPollResult = {
      score: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5,
      postVolume: scores.length,
      lastUpdated: new Date().toISOString(),
    };

    await this.memDir.set(
      { key: "sentiment_subfeed_reddit", symbol },
      { score: result.score, postVolume: result.postVolume, lastUpdated: result.lastUpdated },
      { ttlMs: 14_400_000, source: "RedditFeed" },
    );

    await this.memDir.set(
      { key: "sentiment_health", symbol: "reddit" },
      { lastSuccessfulPoll: result.lastUpdated, isStale: false },
      { ttlMs: null, source: "RedditFeed" },
    );

    return result;
  }
}
