import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";
import { z } from "zod";
import type { IFeed } from "./types.js";

const FNG_RESPONSE_SCHEMA = z.object({
  data: z
    .array(
      z.object({
        value: z.string(),
        value_classification: z.string(),
      }),
    )
    .min(1),
});

const LABEL_MAP: Record<string, "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed"> = {
  "Extreme Fear": "extreme_fear",
  Fear: "fear",
  Neutral: "neutral",
  Greed: "greed",
  "Extreme Greed": "extreme_greed",
};

function normalizeLabel(
  raw: string,
): "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed" {
  return LABEL_MAP[raw] ?? "neutral";
}

function clampScore(raw: number): number {
  if (raw < 0 || raw > 1) {
    console.warn(`[FearGreedFeed] score ${raw} out of [0,1] — clamping`);
    return Math.max(0, Math.min(1, raw));
  }
  return raw;
}

export interface FearGreedFeedOptions {
  memDir: ReturnType<typeof createMemDir>;
}

export type FearGreedPollResult = {
  score: number;
  label: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
  lastUpdated: string;
};

export class FearGreedFeed implements IFeed<FearGreedPollResult> {
  readonly feedId = "fear_greed";
  readonly schedule = "0 */4 * * *";

  private readonly memDir: ReturnType<typeof createMemDir>;

  constructor(opts: FearGreedFeedOptions) {
    this.memDir = opts.memDir;
  }

  async poll(): Promise<FearGreedPollResult> {
    const response = await axios.get("https://api.alternative.me/fng/?limit=1", {
      timeout: 10_000,
    });

    const parsed = FNG_RESPONSE_SCHEMA.parse(response.data);
    const rawValue = Number(parsed.data[0]!.value);
    const rawLabel = parsed.data[0]!.value_classification;

    const score = clampScore(rawValue / 100);
    const label = normalizeLabel(rawLabel);
    const lastUpdated = new Date().toISOString();

    const result: FearGreedPollResult = { score, label, lastUpdated };

    await this.memDir.set(
      { key: "sentiment_subfeed_fear_greed", symbol: "*" },
      { score, label, lastUpdated },
      { ttlMs: 14_400_000, source: "FearGreedFeed" },
    );

    await this.memDir.set(
      { key: "sentiment_health", symbol: "fear_greed" },
      { lastSuccessfulPoll: lastUpdated, isStale: false },
      { ttlMs: null, source: "FearGreedFeed" },
    );

    return result;
  }
}
