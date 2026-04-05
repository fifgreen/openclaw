// Public surface of the market-data-ingestion plugin.
// External consumers MUST import from this file only.
// Internal modules MUST NOT be imported by other extensions directly.

export type { PriceTick } from "./schema/PriceTick.js";
export { PriceTickSchema } from "./schema/PriceTick.js";

export type { OrderBookSnapshot } from "./schema/OrderBookSnapshot.js";
export { OrderBookSnapshotSchema } from "./schema/OrderBookSnapshot.js";

export type { FundingRate } from "./schema/FundingRate.js";
export { FundingRateSchema } from "./schema/FundingRate.js";

export type { OHLCV } from "./schema/OHLCV.js";
export { OHLCVSchema } from "./schema/OHLCV.js";

export type { ExchangeAdapter } from "./adapters/types.js";
