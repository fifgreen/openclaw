import { z } from "zod";

/** Full quantitative feature vector for a trading symbol. */
export const QuantFeatureVectorSchema = z.object({
  symbol: z.string(),
  timestamp: z.number().int().positive(),

  // --- Technical Indicators ---
  ema9: z.number().finite().nullable(),
  ema21: z.number().finite().nullable(),
  ema50: z.number().finite().nullable(),
  ema200: z.number().finite().nullable(),
  rsi: z.number().finite().nullable(),
  macdLine: z.number().finite().nullable(),
  macdSignal: z.number().finite().nullable(),
  macdHistogram: z.number().finite().nullable(),
  bollingerUpper: z.number().finite().nullable(),
  bollingerMiddle: z.number().finite().nullable(),
  bollingerLower: z.number().finite().nullable(),
  /** 0 = at lower band, 1 = at upper band */
  bollingerPosition: z.number().finite().nullable(),
  /** Stochastic RSI in [0, 1] */
  stochRsi: z.number().finite().nullable(),
  /** Average Directional Index [0, 100]; >25 = trending */
  adx: z.number().finite().nullable(),
  /** Average True Range in price units */
  atr: z.number().finite().nullable(),

  // --- Order Flow ---
  /** Fraction of bid depth at top N levels (0 = all asks, 1 = all bids) */
  obImbalance: z.number().finite().nullable(),
  /** Cumulative Volume Delta over rolling window (base asset units) */
  cvd: z.number().finite().nullable(),
  /** Fraction of volume that is buyer-initiated over rolling window */
  tradeFlowBuyPct: z.number().finite().nullable(),
  /** Standard deviations of current spread from rolling mean */
  spreadZScore: z.number().finite().nullable(),
  /** Number of trades exceeding the large-trade threshold in the last hour */
  largeTradeCount: z.number().int().nullable(),
  /** Net large-trade bias: positive = net buy pressure, negative = sell */
  largeTradeNetBias: z.number().finite().nullable(),

  // --- Statistical Models ---
  /** Annualized Yang-Zhang realized volatility (e.g. 0.48 = 48%) */
  realizedVol: z.number().finite().nullable(),
  /** Hurst exponent [0, 1]: >0.55 trending, <0.45 mean-reverting */
  hurstExponent: z.number().finite().nullable(),
  /** Market regime derived from Hurst exponent */
  regime: z.enum(["trending", "ranging", "neutral"]).nullable(),
  /** Rolling Pearson correlation between BTC and ETH close prices */
  btcEthCorrelation: z.number().finite().nullable(),

  // --- Risk Metrics ---
  /** Parametric 1-day 95% VaR as fraction of position value */
  var95: z.number().finite().nullable(),
  /** Parametric 1-day 99% VaR as fraction of position value */
  var99: z.number().finite().nullable(),
  /** Current drawdown on equity curve [0, 1] */
  currentDrawdown: z.number().finite().nullable(),
  /** Maximum drawdown in lookback window [0, 1] */
  maxDrawdown: z.number().finite().nullable(),
  /** Raw Kelly fraction before capping */
  kellyFraction: z.number().finite().nullable(),
  /** Fractional Kelly × account equity — recommended position size in quote currency */
  kellyPositionSize: z.number().finite().nullable(),
  /** Final position cap after Kelly + VaR + drawdown gates */
  maxPositionSize: z.number().finite().nullable(),
  /** Macro regime passed through from sentiment plugin or defaulted to "neutral" */
  macroRegime: z.enum(["risk-on", "risk-off", "neutral"]),
});

export type QuantFeatureVector = z.infer<typeof QuantFeatureVectorSchema>;

/** Indicator-only subset of the feature vector. */
export type IndicatorSet = Pick<
  QuantFeatureVector,
  | "ema9"
  | "ema21"
  | "ema50"
  | "ema200"
  | "rsi"
  | "macdLine"
  | "macdSignal"
  | "macdHistogram"
  | "bollingerUpper"
  | "bollingerMiddle"
  | "bollingerLower"
  | "bollingerPosition"
  | "stochRsi"
  | "adx"
  | "atr"
>;

/** Order flow metrics subset of the feature vector. */
export type OrderFlowMetrics = Pick<
  QuantFeatureVector,
  | "obImbalance"
  | "cvd"
  | "tradeFlowBuyPct"
  | "spreadZScore"
  | "largeTradeCount"
  | "largeTradeNetBias"
>;

/** Risk metrics subset of the feature vector. */
export type RiskMetrics = Pick<
  QuantFeatureVector,
  | "var95"
  | "var99"
  | "currentDrawdown"
  | "maxDrawdown"
  | "kellyFraction"
  | "kellyPositionSize"
  | "maxPositionSize"
>;
