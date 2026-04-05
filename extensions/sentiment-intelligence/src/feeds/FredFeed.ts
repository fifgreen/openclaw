import axios from "axios";
import { z } from "zod";
import type { IFeed } from "./types.js";

const FRED_SERIES = {
  dxy: "DTWEXBGS",
  us10y: "DGS10",
  m2Supply: "M2SL",
  oilPriceWti: "DCOILWTICO",
} as const;

const FredObservationSchema = z.object({
  observations: z
    .array(
      z.object({
        value: z.string(),
        date: z.string(),
      }),
    )
    .min(1),
});

const CmcGlobalSchema = z.object({
  data: z.object({
    quote: z.object({
      USD: z.object({
        total_market_cap: z.number(),
        btc_dominance: z.number(),
      }),
    }),
  }),
});

function parseFredValue(raw: string): number | null {
  if (raw === ".") return null; // FRED uses "." for missing
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

export interface FredFeedResult {
  dxy: number | null;
  us10y: number | null;
  m2Supply: number | null;
  oilPriceWti: number | null;
  globalMarketCap: number | null;
  btcDominance: number | null;
  effectiveDate: string;
}

export interface FredFeedOptions {
  fredApiKey: string;
  coinMarketCapApiKey?: string;
}

export class FredFeed implements IFeed<FredFeedResult> {
  readonly feedId = "fred";
  readonly schedule = "0 6 * * *"; // daily 06:00 UTC

  private readonly fredApiKey: string;
  private readonly cmcApiKey: string | undefined;

  constructor(opts: FredFeedOptions) {
    this.fredApiKey = opts.fredApiKey;
    this.cmcApiKey = opts.coinMarketCapApiKey;
  }

  async poll(): Promise<FredFeedResult> {
    const fredRequests = Object.entries(FRED_SERIES).map(async ([field, seriesId]) => {
      try {
        const res = await axios.get(
          `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${this.fredApiKey}&sort_order=desc&limit=1&file_type=json`,
          { timeout: 15_000 },
        );
        const parsed = FredObservationSchema.parse(res.data);
        return [field, parseFredValue(parsed.observations[0]!.value)] as [string, number | null];
      } catch {
        return [field, null] as [string, number | null];
      }
    });

    const fredResults = await Promise.all(fredRequests);
    const fredMap = Object.fromEntries(fredResults) as Record<string, number | null>;

    let globalMarketCap: number | null = null;
    let btcDominance: number | null = null;

    if (this.cmcApiKey) {
      try {
        const cmcRes = await axios.get(
          "https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest",
          {
            timeout: 15_000,
            headers: { "X-CMC_PRO_API_KEY": this.cmcApiKey },
          },
        );
        const cmcParsed = CmcGlobalSchema.parse(cmcRes.data);
        globalMarketCap = cmcParsed.data.quote.USD.total_market_cap;
        btcDominance = cmcParsed.data.quote.USD.btc_dominance;
      } catch {
        console.warn(
          "[FredFeed] CoinMarketCap API unavailable — globalMarketCap/btcDominance null",
        );
      }
    } else {
      console.warn(
        "[FredFeed] coinMarketCapApiKey not configured — globalMarketCap/btcDominance null",
      );
    }

    return {
      dxy: fredMap["dxy"] ?? null,
      us10y: fredMap["us10y"] ?? null,
      m2Supply: fredMap["m2Supply"] ?? null,
      oilPriceWti: fredMap["oilPriceWti"] ?? null,
      globalMarketCap,
      btcDominance,
      effectiveDate: new Date().toISOString().slice(0, 10),
    };
  }
}
