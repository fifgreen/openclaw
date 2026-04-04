import WebSocket from "ws";
import { FundingRateSchema, type FundingRate } from "../schema/FundingRate.js";
import { OrderBookSnapshotSchema, type OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import { PriceTickSchema, type PriceTick } from "../schema/PriceTick.js";
import type { ExchangeAdapter } from "./types.js";

/** Normalize a Bybit symbol string (e.g. "BTCUSDT") to BASE/QUOTE (e.g. "BTC/USDT"). */
function normalizeSymbol(raw: string): string {
  const quotes = ["USDT", "USDC", "BTC", "ETH"];
  for (const q of quotes) {
    if (raw.endsWith(q)) {
      return `${raw.slice(0, raw.length - q.length)}/${q}`;
    }
  }
  return raw;
}

type TickCallback = (tick: PriceTick) => void;
type OBDeltaCallback = (snapshot: OrderBookSnapshot) => void;
type FundingRateCallback = (rate: FundingRate) => void;

interface BybitAdapterOptions {
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
}

const BYBIT_WS_URL = "wss://stream.bybit.com/v5/public";

/**
 * BybitAdapter: subscribes to Bybit Spot and Linear unified WebSocket.
 * Normalizes raw Bybit V5 messages to shared typed schemas.
 */
export class BybitAdapter implements ExchangeAdapter {
  private symbols: string[] = [];
  private tickCallbacks: TickCallback[] = [];
  private obDeltaCallbacks: OBDeltaCallback[] = [];
  private fundingRateCallbacks: FundingRateCallback[] = [];

  private spotWs: WebSocket | null = null;
  private linearWs: WebSocket | null = null;

  private spotReconnectAttempt = 0;
  private linearReconnectAttempt = 0;
  private spotHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private linearHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private spotPongTimer: ReturnType<typeof setTimeout> | null = null;
  private linearPongTimer: ReturnType<typeof setTimeout> | null = null;

  private disconnecting = false;

  private readonly opts: Required<BybitAdapterOptions>;

  constructor(opts: BybitAdapterOptions = {}) {
    this.opts = {
      reconnectBaseMs: opts.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: opts.reconnectMaxMs ?? 30_000,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 10_000,
      pongTimeoutMs: opts.pongTimeoutMs ?? 5_000,
    };
  }

  onTick(cb: TickCallback): void {
    this.tickCallbacks.push(cb);
  }

  onOBDelta(cb: OBDeltaCallback): void {
    this.obDeltaCallbacks.push(cb);
  }

  onFundingRate(cb: FundingRateCallback): void {
    this.fundingRateCallbacks.push(cb);
  }

  subscribe(symbols: string[]): void {
    this.symbols = symbols;
  }

  async connect(): Promise<void> {
    this.disconnecting = false;
    this.spotReconnectAttempt = 0;
    this.linearReconnectAttempt = 0;
    this.connectSpot();
    this.connectLinear();
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.clearHeartbeat("spot");
    this.clearHeartbeat("linear");
    if (this.spotWs) {
      this.spotWs.removeAllListeners();
      this.spotWs.terminate();
      this.spotWs = null;
    }
    if (this.linearWs) {
      this.linearWs.removeAllListeners();
      this.linearWs.terminate();
      this.linearWs = null;
    }
    console.info("[BybitAdapter] disconnected");
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildSubscribeMsg(category: "spot" | "linear"): string {
    const rawSymbols = this.symbols.map((s) => s.replace("/", ""));
    const topics: string[] = [];
    for (const sym of rawSymbols) {
      topics.push(`trade.${sym}`);
      topics.push(`orderbook.50.${sym}`);
      if (category === "linear") {
        topics.push(`tickers.${sym}`); // contains funding rate for linear
      }
    }
    return JSON.stringify({ op: "subscribe", args: topics });
  }

  private connectSpot(): void {
    const url = `${BYBIT_WS_URL}/spot`;
    console.info("[BybitAdapter] connecting Spot WS:", url);
    const ws = new WebSocket(url);
    this.spotWs = ws;

    ws.on("open", () => {
      console.info("[BybitAdapter] Spot WS connected");
      this.spotReconnectAttempt = 0;
      ws.send(this.buildSubscribeMsg("spot"));
      this.startHeartbeat("spot", ws);
    });

    ws.on("message", (data: Buffer | string) => {
      this.handleMessage(String(data));
    });

    ws.on("pong", () => {
      if (this.spotPongTimer !== null) {
        clearTimeout(this.spotPongTimer);
        this.spotPongTimer = null;
      }
    });

    ws.on("close", () => {
      console.info("[BybitAdapter] Spot WS closed");
      this.clearHeartbeat("spot");
      if (!this.disconnecting) this.scheduleReconnect("spot");
    });

    ws.on("error", (err: Error) => {
      console.warn("[BybitAdapter] Spot WS error:", err.message);
    });
  }

  private connectLinear(): void {
    const url = `${BYBIT_WS_URL}/linear`;
    console.info("[BybitAdapter] connecting Linear WS:", url);
    const ws = new WebSocket(url);
    this.linearWs = ws;

    ws.on("open", () => {
      console.info("[BybitAdapter] Linear WS connected");
      this.linearReconnectAttempt = 0;
      ws.send(this.buildSubscribeMsg("linear"));
      this.startHeartbeat("linear", ws);
    });

    ws.on("message", (data: Buffer | string) => {
      this.handleMessage(String(data));
    });

    ws.on("pong", () => {
      if (this.linearPongTimer !== null) {
        clearTimeout(this.linearPongTimer);
        this.linearPongTimer = null;
      }
    });

    ws.on("close", () => {
      console.info("[BybitAdapter] Linear WS closed");
      this.clearHeartbeat("linear");
      if (!this.disconnecting) this.scheduleReconnect("linear");
    });

    ws.on("error", (err: Error) => {
      console.warn("[BybitAdapter] Linear WS error:", err.message);
    });
  }

  private startHeartbeat(lane: "spot" | "linear", ws: WebSocket): void {
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      const pongTimer = setTimeout(() => {
        console.warn(`[BybitAdapter] ${lane} pong timeout — reconnecting`);
        ws.terminate();
      }, this.opts.pongTimeoutMs);
      if (lane === "spot") {
        this.spotPongTimer = pongTimer;
      } else {
        this.linearPongTimer = pongTimer;
      }
    }, this.opts.heartbeatIntervalMs);

    if (lane === "spot") {
      this.spotHeartbeatTimer = timer;
    } else {
      this.linearHeartbeatTimer = timer;
    }
  }

  private clearHeartbeat(lane: "spot" | "linear"): void {
    if (lane === "spot") {
      if (this.spotHeartbeatTimer !== null) {
        clearInterval(this.spotHeartbeatTimer);
        this.spotHeartbeatTimer = null;
      }
      if (this.spotPongTimer !== null) {
        clearTimeout(this.spotPongTimer);
        this.spotPongTimer = null;
      }
    } else {
      if (this.linearHeartbeatTimer !== null) {
        clearInterval(this.linearHeartbeatTimer);
        this.linearHeartbeatTimer = null;
      }
      if (this.linearPongTimer !== null) {
        clearTimeout(this.linearPongTimer);
        this.linearPongTimer = null;
      }
    }
  }

  private scheduleReconnect(lane: "spot" | "linear"): void {
    const attempt = lane === "spot" ? ++this.spotReconnectAttempt : ++this.linearReconnectAttempt;
    const backoff = Math.min(
      this.opts.reconnectBaseMs * Math.pow(2, attempt - 1),
      this.opts.reconnectMaxMs,
    );
    const jitter = 0.25;
    const delay = backoff * (1 + (Math.random() * 2 - 1) * jitter);
    console.info(
      `[BybitAdapter] reconnecting ${lane} in ${Math.round(delay)}ms (attempt ${attempt})`,
    );
    setTimeout(() => {
      if (!this.disconnecting) {
        if (lane === "spot") {
          this.connectSpot();
        } else {
          this.connectLinear();
        }
      }
    }, delay);
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn("[BybitAdapter] failed to parse message JSON");
      return;
    }

    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    const topic = typeof m["topic"] === "string" ? m["topic"] : "";
    const data = m["data"];
    const localTimestamp = Date.now();

    if (topic.startsWith("trade.")) {
      this.handleTrade(data, topic, localTimestamp);
    } else if (topic.startsWith("orderbook.")) {
      this.handleOrderBook(data, topic, localTimestamp, m);
    } else if (topic.startsWith("tickers.")) {
      this.handleTicker(data, topic, localTimestamp);
    }
  }

  private handleTrade(data: unknown, topic: string, localTimestamp: number): void {
    if (!Array.isArray(data)) return;
    const rawSym = topic.replace("trade.", "");
    const symbol = normalizeSymbol(rawSym);

    for (const entry of data as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;

      const parsed = PriceTickSchema.safeParse({
        exchange: "bybit",
        symbol,
        price: Number(e["p"]),
        quantity: Number(e["v"]),
        side: e["S"] === "Buy" ? "buy" : "sell",
        tradeId: String(e["i"] ?? ""),
        timestamp: Number(e["T"]),
        localTimestamp,
      });

      if (!parsed.success) {
        console.warn("[BybitAdapter] PriceTick parse failed:", parsed.error.issues[0]?.message);
        continue;
      }

      for (const cb of this.tickCallbacks) cb(parsed.data);
    }
  }

  private handleOrderBook(
    data: unknown,
    topic: string,
    _localTimestamp: number,
    envelope: Record<string, unknown>,
  ): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;
    const rawSym = topic.split(".").at(-1) ?? "";
    const symbol = normalizeSymbol(rawSym);

    const parseLevels = (arr: unknown): [number, number][] => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length < 2) return null;
          return [Number(entry[0]), Number(entry[1])] as [number, number];
        })
        .filter((x): x is [number, number] => x !== null);
    };

    const bids = parseLevels(d["b"]);
    const asks = parseLevels(d["a"]);
    const seqId = Number(d["seq"] ?? envelope["seq"] ?? 0);
    const ts = Number(d["ts"] ?? envelope["ts"] ?? Date.now());

    const parsed = OrderBookSnapshotSchema.safeParse({
      exchange: "bybit",
      symbol,
      bids,
      asks,
      depth: Math.max(bids.length, asks.length),
      sequenceId: seqId,
      timestamp: ts,
    });

    if (!parsed.success) {
      console.warn("[BybitAdapter] OBSnapshot parse failed:", parsed.error.issues[0]?.message);
      return;
    }

    for (const cb of this.obDeltaCallbacks) cb(parsed.data);
  }

  private handleTicker(data: unknown, topic: string, localTimestamp: number): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;

    // Only process if funding rate fields are present (linear perpetuals)
    if (!("fundingRate" in d) || !("nextFundingTime" in d)) return;

    const rawSym = topic.replace("tickers.", "");
    const symbol = normalizeSymbol(rawSym);

    const parsed = FundingRateSchema.safeParse({
      exchange: "bybit",
      symbol,
      rate: Number(d["fundingRate"]),
      nextFundingTime: Number(d["nextFundingTime"]),
      timestamp: localTimestamp,
    });

    if (!parsed.success) {
      console.warn("[BybitAdapter] FundingRate parse failed:", parsed.error.issues[0]?.message);
      return;
    }

    for (const cb of this.fundingRateCallbacks) cb(parsed.data);
  }
}
