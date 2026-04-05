import type { OHLCVRow } from "../db/queries.js";
import { computeADX } from "../indicators/adx.js";
import { computeATR } from "../indicators/atr.js";
import { computeBollinger } from "../indicators/bollinger.js";
import { computeEMA } from "../indicators/ema.js";
import { computeMACD } from "../indicators/macd.js";
import { computeRSI } from "../indicators/rsi.js";
import { computeStochRSI } from "../indicators/stochastic-rsi.js";
import { computeCVD } from "../orderflow/cvd.js";
import { computeOBImbalance } from "../orderflow/imbalance.js";
import { detectLargeTrades } from "../orderflow/large-trades.js";
import { computeSpreadZScore } from "../orderflow/spread-zscore.js";
import { computeTradeFlow } from "../orderflow/trade-flow.js";
import { computeDrawdown } from "../risk/drawdown.js";
import { kellyFraction } from "../risk/kelly.js";
import type { RiskConfig } from "../risk/position-size.js";
import { computeMaxPositionSize } from "../risk/position-size.js";
import { parametricVaR } from "../risk/var.js";
import type { QuantFeatureVector } from "../schema/QuantFeatureVector.js";
import { rollingCorrelation } from "../stats/correlation.js";
import { computeHurst } from "../stats/hurst.js";
import { detectRegime } from "../stats/regime.js";
import { yangZhangVolatility } from "../stats/volatility.js";

export interface PriceTickRecord {
  quantity: number;
  side: "buy" | "sell";
  price: number;
  timestamp: number;
}

export interface OBSnapshotRecord {
  bids: [number, number][];
  asks: [number, number][];
}

export interface QuantConfig {
  hurstWindow: number;
  orderflowWindowMs: number;
  largeTradeThresholdUsd: number;
  spreadHistoryLength: number;
  varConfidence95: number;
  varConfidence99: number;
  risk: RiskConfig;
  accountEquity: number;
  equityCurve: number[];
  btcEthOhlcv?: OHLCVRow[]; // for BTC/ETH correlation
}

/** Replace non-finite numbers with null. */
function finite(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Number.isFinite(n) ? n : null;
}

/**
 * Builds a full QuantFeatureVector from OHLCV, tick, and OB data.
 * All fields apply `Number.isFinite()` guards — non-finite values become null.
 */
export function buildQuantFeatureVector(
  symbol: string,
  ohlcv: OHLCVRow[],
  ticks: PriceTickRecord[],
  ob: OBSnapshotRecord | null,
  spreadHistory: number[],
  cfg: QuantConfig,
): QuantFeatureVector {
  const closes = ohlcv.map((r) => r.close);
  const now = Date.now();

  // --- Technical Indicators ---
  const ema9 = finite(computeEMA(closes, 9));
  const ema21 = finite(computeEMA(closes, 21));
  const ema50 = finite(computeEMA(closes, 50));
  const ema200 = finite(computeEMA(closes, 200));
  const rsi = finite(computeRSI(closes, 14));
  const macd = computeMACD(closes);
  const bollinger = computeBollinger(closes, 20, 2);
  const stochRsi = finite(computeStochRSI(closes, 14));
  const adx = finite(computeADX(ohlcv, 14));
  const atr = finite(computeATR(ohlcv, 14));

  // --- Order Flow ---
  let obImbalance: number | null = null;
  let cvd: number | null = null;
  let tradeFlowBuyPct: number | null = null;
  let spreadZScore: number | null = null;
  let largeTradeCount: number | null = null;
  let largeTradeNetBias: number | null = null;

  if (ticks.length > 0) {
    const cvdVal = computeCVD(ticks, cfg.orderflowWindowMs, now);
    cvd = finite(cvdVal);

    const flow = computeTradeFlow(ticks, cfg.orderflowWindowMs, now);
    tradeFlowBuyPct = finite(flow.buyPct);

    const largeTrades = detectLargeTrades(
      ticks,
      cfg.largeTradeThresholdUsd,
      cfg.orderflowWindowMs,
      now,
    );
    largeTradeCount = largeTrades.count;
    largeTradeNetBias = finite(largeTrades.netBias);
  }

  if (ob !== null) {
    obImbalance = finite(computeOBImbalance(ob.bids, ob.asks, 5));
  }

  if (spreadHistory.length >= 2 && closes.length > 0) {
    const currentClose = closes[closes.length - 1]!;
    const currentAsk = ob?.asks[0]?.[0] ?? currentClose;
    const currentBid = ob?.bids[0]?.[0] ?? currentClose;
    const currentSpread = currentAsk - currentBid;
    spreadZScore = finite(computeSpreadZScore(currentSpread, spreadHistory));
  }

  // --- Statistical Models ---
  const realizedVol = finite(yangZhangVolatility(ohlcv, 30));
  const hurstExponent = finite(computeHurst(closes, cfg.hurstWindow));
  const regime = detectRegime(hurstExponent);

  let btcEthCorrelation: number | null = null;
  if (cfg.btcEthOhlcv && cfg.btcEthOhlcv.length >= 60) {
    const btcCloses = ohlcv.map((r) => r.close).slice(-60);
    const ethCloses = cfg.btcEthOhlcv.map((r) => r.close).slice(-60);
    btcEthCorrelation = finite(rollingCorrelation(btcCloses, ethCloses, 60));
  }

  // --- Risk Metrics ---
  const kFraction = finite(kellyFraction(0.5, 0.015, 0.01)); // defaults (agent overrides)
  const var95 =
    realizedVol !== null ? finite(parametricVaR(realizedVol, cfg.varConfidence95)) : null;
  const var99 =
    realizedVol !== null ? finite(parametricVaR(realizedVol, cfg.varConfidence99)) : null;
  const drawdown = computeDrawdown(cfg.equityCurve);
  const currentDrawdown = finite(drawdown.current);
  const maxDrawdown = finite(drawdown.max);

  let kellyPositionSize: number | null = null;
  let maxPositionSize: number | null = null;

  if (kFraction !== null && var95 !== null && currentDrawdown !== null) {
    maxPositionSize = finite(
      computeMaxPositionSize({
        kellyFraction: kFraction,
        var95,
        accountEquity: cfg.accountEquity,
        currentDrawdown,
        cfg: cfg.risk,
      }),
    );
    kellyPositionSize = finite(kFraction * cfg.risk.maxKellyFraction * cfg.accountEquity);
  }

  return {
    symbol,
    timestamp: now,
    ema9,
    ema21,
    ema50,
    ema200,
    rsi,
    macdLine: macd ? finite(macd.macdLine) : null,
    macdSignal: macd ? finite(macd.signalLine) : null,
    macdHistogram: macd ? finite(macd.histogram) : null,
    bollingerUpper: bollinger ? finite(bollinger.upper) : null,
    bollingerMiddle: bollinger ? finite(bollinger.middle) : null,
    bollingerLower: bollinger ? finite(bollinger.lower) : null,
    bollingerPosition: bollinger ? finite(bollinger.position) : null,
    stochRsi,
    adx,
    atr,
    obImbalance,
    cvd,
    tradeFlowBuyPct,
    spreadZScore,
    largeTradeCount,
    largeTradeNetBias,
    realizedVol,
    hurstExponent,
    regime,
    btcEthCorrelation,
    var95,
    var99,
    currentDrawdown,
    maxDrawdown,
    kellyFraction: kFraction,
    kellyPositionSize,
    maxPositionSize,
    macroRegime: "neutral",
  };
}
