// Public exports surface for @openclaw/sentiment-intelligence.
// Other plugins and core should import from this barrel.
export type { SentimentSnapshot } from "./schema/SentimentSnapshot.js";
export type { MacroContext } from "./schema/MacroSnapshot.js";
export type { NewsEvent } from "./schema/NewsEvent.js";
export type { FeedAccuracyReport } from "./schema/FeedAccuracy.js";
export type { IFeed } from "./feeds/types.js";
