/** Public API surface for @openclaw/quant-math-engine. */

export type {
  QuantFeatureVector,
  IndicatorSet,
  OrderFlowMetrics,
  RiskMetrics,
} from "./schema/QuantFeatureVector.js";

export { QuantFeatureVectorSchema } from "./schema/QuantFeatureVector.js";

export type { PriceTickRecord, OBSnapshotRecord, QuantConfig } from "./feature-vector/builder.js";

export { buildQuantFeatureVector } from "./feature-vector/builder.js";
export { createFeatureVectorCache } from "./feature-vector/cache.js";
export type { FeatureVectorCache } from "./feature-vector/cache.js";
