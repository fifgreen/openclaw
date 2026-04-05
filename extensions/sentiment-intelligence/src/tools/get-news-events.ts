import { jsonResult } from "openclaw/plugin-sdk/core";
import type { Pool } from "pg";
import { queryNewsEvents } from "../db/queries.js";
import type { NewsEvent } from "../schema/NewsEvent.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface GetNewsEventsOptions {
  newsDefaultLimit?: number;
  newsMaxLimit?: number;
}

/**
 * Returns recent news events, optionally filtered by symbol.
 * limit is capped at newsMaxLimit (default 50).
 * Always returns an array — never a typed error.
 */
export async function getNewsEvents(
  pool: Pool,
  symbol: string | undefined,
  limit: number | undefined,
  opts: GetNewsEventsOptions = {},
): Promise<NewsEvent[]> {
  const defaultLimit = opts.newsDefaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = opts.newsMaxLimit ?? MAX_LIMIT;
  const effectiveLimit = Math.max(1, Math.min(limit ?? defaultLimit, maxLimit));

  const rows = await queryNewsEvents(pool, { symbol, limit: effectiveLimit });

  // Map DB row format to NewsEvent (queries.ts uses snake_case, schema uses camelCase)
  return rows.map((r) => ({
    id: r.id ?? 0,
    headline: r.headline,
    source: r.source,
    url: r.url,
    sentiment: r.sentiment as NewsEvent["sentiment"],
    impactClass: (r.impact_class ?? "other") as NewsEvent["impactClass"],
    classificationConfidence: r.relevance_score,
    symbols: r.symbols,
    publishedAt: r.published_at,
  }));
}

/**
 * Builds an OpenClaw tool descriptor for get_news_events.
 */
export function buildGetNewsEventsTool(pool: Pool, opts: GetNewsEventsOptions = {}) {
  return {
    name: "get_news_events",
    label: "Get News Events",
    description:
      "Returns recent crypto news events, classified by impact category and sentiment. " +
      "Optionally filter by symbol (e.g. 'BTC'). Results are ordered by published_at DESC.",
    parameters: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Filter by ticker symbol, e.g. 'BTC' or 'ETH'. Optional.",
        },
        limit: {
          type: "number",
          description: `Number of events to return (1–${opts.newsMaxLimit ?? MAX_LIMIT}). Default ${opts.newsDefaultLimit ?? DEFAULT_LIMIT}.`,
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = typeof params["symbol"] === "string" ? params["symbol"] : undefined;
      const limit = typeof params["limit"] === "number" ? params["limit"] : undefined;
      const data = await getNewsEvents(pool, symbol, limit, opts);
      return jsonResult(data);
    },
  };
}
