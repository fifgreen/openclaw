import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";
import { z } from "zod";
import type { IFeed } from "./types.js";

const BULLISH_TERMS = ["bull", "moon", "pump", "rally", "ath", "long"];
const BEARISH_TERMS = ["bear", "dump", "crash", "short", "rekt", "capitulation"];

const TwitterResponseSchema = z.object({
  data: z.array(z.object({ text: z.string() })).optional(),
  meta: z.object({ result_count: z.number() }).optional(),
});

const NitterResponseSchema = z.object({
  tweets: z.array(z.object({ content: z.string() })).optional(),
});

/** Score text into [0,1]. 0.5 = neutral. */
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

export interface TwitterFeedOptions {
  memDir: ReturnType<typeof createMemDir>;
  bearerToken?: string;
  nitterBaseUrl?: string;
}

export type TwitterPollResult = {
  score: number;
  tweetVolume: number;
  lastUpdated: string;
};

const NEUTRAL_STUB: Omit<TwitterPollResult, "lastUpdated"> = {
  score: 0.5,
  tweetVolume: 0,
};

export class TwitterFeed implements IFeed<TwitterPollResult> {
  readonly feedId = "twitter";
  readonly schedule = "0 */4 * * *";

  private isDisabled: boolean;
  private readonly memDir: ReturnType<typeof createMemDir>;
  private readonly bearerToken: string | undefined;
  private readonly nitterBaseUrl: string | undefined;

  constructor(opts: TwitterFeedOptions) {
    this.memDir = opts.memDir;
    this.bearerToken = opts.bearerToken;
    this.nitterBaseUrl = opts.nitterBaseUrl;
    this.isDisabled = !opts.bearerToken;
    if (this.isDisabled) {
      console.warn(
        "[TwitterFeed] twitterBearerToken not configured — feed disabled, returning neutral stubs",
      );
    }
  }

  async poll(symbol: string): Promise<TwitterPollResult> {
    const lastUpdated = new Date().toISOString();

    if (this.isDisabled) {
      return { ...NEUTRAL_STUB, lastUpdated };
    }

    try {
      const scores = await this.fetchScores(symbol);
      const score = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5;
      const result: TwitterPollResult = {
        score,
        tweetVolume: scores.length,
        lastUpdated,
      };
      await this.writeMemDir(symbol, result);
      return result;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 429 || status === 403) {
        this.isDisabled = true;
        console.warn(`[TwitterFeed] API returned ${status} — feed disabled`);
        await this.memDir.set(
          { key: "sentiment_health", symbol: "twitter" },
          { lastSuccessfulPoll: lastUpdated, isStale: true },
          { ttlMs: null, source: "TwitterFeed" },
        );
        return { ...NEUTRAL_STUB, lastUpdated };
      }
      throw err;
    }
  }

  private async fetchScores(symbol: string): Promise<number[]> {
    if (this.nitterBaseUrl) {
      try {
        return await this.fetchFromNitter(symbol);
      } catch {
        // fall through to Twitter API
      }
    }
    return this.fetchFromTwitter(symbol);
  }

  private async fetchFromTwitter(symbol: string): Promise<number[]> {
    const response = await axios.get(
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(symbol + " crypto lang:en")}&max_results=100`,
      {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      },
    );
    const parsed = TwitterResponseSchema.parse(response.data);
    return (parsed.data ?? []).map((t) => scoreText(t.text));
  }

  private async fetchFromNitter(symbol: string): Promise<number[]> {
    const response = await axios.get(
      `${this.nitterBaseUrl}/${encodeURIComponent(symbol)}/search.json`,
      { timeout: 10_000 },
    );
    const parsed = NitterResponseSchema.parse(response.data);
    return (parsed.tweets ?? []).map((t) => scoreText(t.content));
  }

  private async writeMemDir(symbol: string, result: TwitterPollResult): Promise<void> {
    await this.memDir.set(
      { key: "sentiment_subfeed_twitter", symbol },
      { score: result.score, postVolume: result.tweetVolume, lastUpdated: result.lastUpdated },
      { ttlMs: 14_400_000, source: "TwitterFeed" },
    );
    await this.memDir.set(
      { key: "sentiment_health", symbol: "twitter" },
      { lastSuccessfulPoll: result.lastUpdated, isStale: false },
      { ttlMs: null, source: "TwitterFeed" },
    );
  }
}
