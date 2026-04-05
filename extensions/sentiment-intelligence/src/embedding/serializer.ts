import type { MacroContext } from "../schema/MacroSnapshot.js";
import type { SentimentSnapshot } from "../schema/SentimentSnapshot.js";

function fmt(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return n.toFixed(4);
}

/**
 * Serializes a SentimentSnapshot to a human-readable text chunk for embedding.
 */
export function serializeSentiment(snapshot: SentimentSnapshot): string {
  return (
    `Sentiment snapshot ${snapshot.lastUpdated} ${snapshot.symbol}: ` +
    `Fear & Greed: ${fmt(snapshot.fearGreedScore)} (${snapshot.fearGreedLabel}). ` +
    `Twitter score: ${fmt(snapshot.twitterScore)} (${snapshot.tweetVolume} tweets). ` +
    `Reddit score: ${fmt(snapshot.redditScore)} (${snapshot.redditPostVolume} posts). ` +
    `Funding bias: ${snapshot.fundingBias} (rate: ${fmt(snapshot.fundingRate * 100)}%). ` +
    `Composite: ${fmt(snapshot.compositeScore)}.`
  );
}

/**
 * Serializes a MacroContext to a human-readable text chunk for embedding.
 */
export function serializeMacro(macro: MacroContext): string {
  return (
    `Macro context ${macro.lastUpdated}: ` +
    `DXY: ${fmt(macro.dxy)}. ` +
    `US10Y: ${fmt(macro.us10y)}%. ` +
    `M2 supply: ${fmt(macro.m2Supply)}B USD. ` +
    `Oil (WTI): ${fmt(macro.oilPriceWti)} USD/bbl. ` +
    `Global market cap: ${fmt(macro.globalMarketCap)} USD. ` +
    `BTC dominance: ${fmt(macro.btcDominance)}%. ` +
    `FOMC next: ${macro.fomcNextDate ?? "N/A"}, last action: ${macro.fomcLastAction ?? "N/A"}. ` +
    `CPI: ${fmt(macro.cpiLastReading)}, next release: ${macro.cpiNextDate ?? "N/A"}. ` +
    `Regime: ${macro.regime}.`
  );
}
