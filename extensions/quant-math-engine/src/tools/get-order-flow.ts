import type { PriceTickRecord, OBSnapshotRecord } from "../feature-vector/builder.js";
import { computeCVD } from "../orderflow/cvd.js";
import { computeOBImbalance } from "../orderflow/imbalance.js";
import { detectLargeTrades } from "../orderflow/large-trades.js";
import { computeSpreadZScore } from "../orderflow/spread-zscore.js";
import { computeTradeFlow } from "../orderflow/trade-flow.js";
import type { OrderFlowMetrics } from "../schema/QuantFeatureVector.js";

export interface OrderFlowDeps {
  getTicks: (symbol: string) => PriceTickRecord[];
  getOBSnapshot: (symbol: string) => OBSnapshotRecord | null;
  getSpreadHistory: (symbol: string) => number[];
  orderflowWindowMs: number;
  largeTradeThresholdUsd: number;
}

function finite(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Number.isFinite(n) ? n : null;
}

export async function getOrderFlowHandler(
  deps: OrderFlowDeps,
  symbol: string,
): Promise<OrderFlowMetrics | { error: "no_data"; message: string }> {
  const now = Date.now();
  const ticks = deps.getTicks(symbol);
  const ob = deps.getOBSnapshot(symbol);
  const spreadHistory = deps.getSpreadHistory(symbol);

  if (ticks.length === 0 && ob === null) {
    return {
      error: "no_data",
      message: `No live tick or order book data for ${symbol}. Ensure market-data-ingestion is running and symbol is subscribed.`,
    };
  }

  let obImbalance: number | null = null;
  let spreadZScore: number | null = null;

  if (ob !== null) {
    obImbalance = finite(computeOBImbalance(ob.bids, ob.asks, 5));
    // Compute current spread for Z-score
    const currentAsk = ob.asks[0]?.[0];
    const currentBid = ob.bids[0]?.[0];
    if (currentAsk !== undefined && currentBid !== undefined && spreadHistory.length >= 2) {
      spreadZScore = finite(computeSpreadZScore(currentAsk - currentBid, spreadHistory));
    }
  }

  const cvd = finite(computeCVD(ticks, deps.orderflowWindowMs, now));
  const flow = computeTradeFlow(ticks, deps.orderflowWindowMs, now);
  const tradeFlowBuyPct = finite(flow.buyPct);
  const largeTrades = detectLargeTrades(
    ticks,
    deps.largeTradeThresholdUsd,
    deps.orderflowWindowMs,
    now,
  );

  const metrics: OrderFlowMetrics = {
    obImbalance,
    cvd,
    tradeFlowBuyPct,
    spreadZScore,
    largeTradeCount: largeTrades.count,
    largeTradeNetBias: finite(largeTrades.netBias),
  };

  return metrics;
}

/** Build the OpenClaw tool definition for `get_order_flow`. */
export function buildGetOrderFlowTool(deps: OrderFlowDeps) {
  return {
    name: "get_order_flow",
    label: "Get Order Flow",
    description:
      "Returns live order flow analytics (OB imbalance, CVD, trade flow buy%, spread Z-score, large trades) " +
      "for a trading symbol from in-process WebSocket feed buffers. " +
      "Requires market-data-ingestion to be running and the symbol to be subscribed.",
    parameters: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Trading pair in BASE/QUOTE format, e.g. "BTC/USDT"',
        },
      },
      required: ["symbol"] as string[],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = String(params["symbol"] ?? "");
      const result = await getOrderFlowHandler(deps, symbol);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
