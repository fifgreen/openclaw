import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import { SentimentSnapshotSchema } from "../schema/SentimentSnapshot.js";
import type { SentimentSnapshot } from "../schema/SentimentSnapshot.js";

export type GetSentimentResult = SentimentSnapshot | { error: "not_found" };

/**
 * Hot-path: single Redis GET, no network or DB calls.
 * Returns the composite SentimentSnapshot from MemDir, or { error: "not_found" }
 * if the key has expired or no poll cycle has run yet.
 */
export async function getSentiment(
  symbol: string | undefined,
  memDir: ReturnType<typeof createMemDir>,
): Promise<GetSentimentResult> {
  const lookupSymbol = symbol ?? "global";
  const entry = await memDir.get({ key: "sentiment_composite", symbol: lookupSymbol });

  if (!entry) {
    return { error: "not_found" };
  }

  const parsed = SentimentSnapshotSchema.safeParse(entry.value);
  if (!parsed.success) {
    return { error: "not_found" };
  }

  return parsed.data;
}

export function buildGetSentimentTool(memDir: ReturnType<typeof createMemDir>) {
  return {
    name: "get_sentiment",
    label: "Get Sentiment",
    description:
      "Returns the composite sentiment snapshot for a symbol (or global market if omitted). Hot path — reads from MemDir only, resolves within 100 ms.",
    parameters: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Crypto symbol, e.g. "BTC". Omit for global market sentiment.',
        },
      },
    },
    async execute(args: { symbol?: string }): Promise<GetSentimentResult> {
      return getSentiment(args.symbol, memDir);
    },
  };
}
