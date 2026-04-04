import WebSocket from "ws";
import { FundingRateSchema } from "../schema/FundingRate.js";
import type { FundingRate } from "../schema/FundingRate.js";
import { OrderBookSnapshotSchema, type OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import { PriceTickSchema, type PriceTick } from "../schema/PriceTick.js";
import type { ExchangeAdapter } from "./types.js";

/** Normalize a Binance symbol string (e.g. "BTCUSDT") to BASE/QUOTE (e.g. "BTC/USDT"). */
function normalizeSymbol(raw: string): string {
  // Common quote currencies in order of preference
  const quotes = ["USDT", "BUSD", "USDC", "BTC", "ETH", "BNB"];
  for (const q of quotes) {
    if (raw.endsWith(q)) {
      return `${raw.slice(0, raw.length - q.length)}/${q}`;
    }
  }
  // Fallback: return as-is so no data is silently lost
  return raw;
}

type TickCallback = (tick: PriceTick) => void;
type OBDeltaCallback = (snapshot: OrderBookSnapshot) => void;
type FundingRateCallback = (rate: FundingRate) => void;

interface BinanceAdapterOptions {
  /** Reconnect base delay in seconds (default: 1) */
  reconnectBaseMs?: number;
  /** Reconnect max delay in seconds (default: 30 000) */
  reconnectMaxMs?: number;
  /** Heartbeat interval in seconds (default: 10 000) */
  heartbeatIntervalMs?: number;
  /** Pong timeout before reconnect in ms (default: 5 000) */
  pongTimeoutMs?: number;
}

const SPOT_WS_BASE = "wss://stream.binance.com:9443/stream";
const FUTURES_WS_BASE = "wss://fstream.binance.com/stream";

/**
 * BinanceAdapter: subscribes to Spot and USDT-M Futures WebSocket streams.
 * Normalizes raw trade/depth/markPrice messages to the shared typed schemas.
 * Implements exponential-backoff reconnect and heartbeat ping/pong.
 */
export class BinanceAdapter implements ExchangeAdapter {
  private symbols: string[] = [];
  private tickCallbacks: TickCallback[] = [];
  private obDeltaCallbacks: OBDeltaCallback[] = [];
  private fundingRateCallbacks: FundingRateCallback[] = [];

  private spotWs: WebSocket | null = null;
  private futuresWs: WebSocket | null = null;

  private spotReconnectAttempt = 0;
  private futuresReconnectAttempt = 0;
  private spotHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private futuresHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private spotPongTimer: ReturnType<typeof setTimeout> | null = null;
  private futuresPongTimer: ReturnType<typeof setTimeout> | null = null;

  private disconnecting = false;

  private readonly opts: Required<BinanceAdapterOptions>;

  constructor(opts: BinanceAdapterOptions = {}) {
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
    this.futuresReconnectAttempt = 0;
    this.connectSpot();
    this.connectFutures();
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.clearHeartbeat("spot");
    this.clearHeartbeat("futures");
    if (this.spotWs) {
      this.spotWs.removeAllListeners();
      this.spotWs.terminate();
      this.spotWs = null;
    }
    if (this.futuresWs) {
      this.futuresWs.removeAllListeners();
      this.futuresWs.terminate();
      this.futuresWs = null;
    }
    console.info("[BinanceAdapter] disconnected");
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildUrl(base: string): string {
    if (this.symbols.length === 0) return `${base}?streams=`;
    const rawSymbols = this.symbols.map((s) => s.replace("/", "").toLowerCase());
    const streams = rawSymbols.flatMap((sym) => [
      `${sym}@trade`,
      `${sym}@depth@100ms`,
      `${sym}@markPrice`,
    ]);
    return `${base}?streams=${streams.join("/")}`;
  }

  private connectSpot(): void {
    const url = this.buildUrl(SPOT_WS_BASE);
    console.info("[BinanceAdapter] connecting Spot WS:", url);
    const ws = new WebSocket(url);
    this.spotWs = ws;

    ws.on("open", () => {
      console.info("[BinanceAdapter] Spot WS connected");
      this.spotReconnectAttempt = 0;
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
      console.info("[BinanceAdapter] Spot WS closed");
      this.clearHeartbeat("spot");
      if (!this.disconnecting) {
        this.scheduleReconnect("spot");
      }
    });

    ws.on("error", (err: Error) => {
      console.warn("[BinanceAdapter] Spot WS error:", err.message);
    });
  }

  private connectFutures(): void {
    const url = this.buildUrl(FUTURES_WS_BASE);
    console.info("[BinanceAdapter] connecting Futures WS:", url);
    const ws = new WebSocket(url);
    this.futuresWs = ws;

    ws.on("open", () => {
      console.info("[BinanceAdapter] Futures WS connected");
      this.futuresReconnectAttempt = 0;
      this.startHeartbeat("futures", ws);
    });

    ws.on("message", (data: Buffer | string) => {
      this.handleMessage(String(data));
    });

    ws.on("pong", () => {
      if (this.futuresPongTimer !== null) {
        clearTimeout(this.futuresPongTimer);
        this.futuresPongTimer = null;
      }
    });

    ws.on("close", () => {
      console.info("[BinanceAdapter] Futures WS closed");
      this.clearHeartbeat("futures");
      if (!this.disconnecting) {
        this.scheduleReconnect("futures");
      }
    });

    ws.on("error", (err: Error) => {
      console.warn("[BinanceAdapter] Futures WS error:", err.message);
    });
  }

  private startHeartbeat(lane: "spot" | "futures", ws: WebSocket): void {
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      // Set pong timeout
      const pongTimer = setTimeout(() => {
        console.warn(`[BinanceAdapter] ${lane} pong timeout — reconnecting`);
        ws.terminate();
      }, this.opts.pongTimeoutMs);
      if (lane === "spot") {
        this.spotPongTimer = pongTimer;
      } else {
        this.futuresPongTimer = pongTimer;
      }
    }, this.opts.heartbeatIntervalMs);

    if (lane === "spot") {
      this.spotHeartbeatTimer = timer;
    } else {
      this.futuresHeartbeatTimer = timer;
    }
  }

  private clearHeartbeat(lane: "spot" | "futures"): void {
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
      if (this.futuresHeartbeatTimer !== null) {
        clearInterval(this.futuresHeartbeatTimer);
        this.futuresHeartbeatTimer = null;
      }
      if (this.futuresPongTimer !== null) {
        clearTimeout(this.futuresPongTimer);
        this.futuresPongTimer = null;
      }
    }
  }

  private scheduleReconnect(lane: "spot" | "futures"): void {
    const attempt = lane === "spot" ? ++this.spotReconnectAttempt : ++this.futuresReconnectAttempt;
    const base = this.opts.reconnectBaseMs;
    const max = this.opts.reconnectMaxMs;
    const jitter = 0.25;
    const backoff = Math.min(base * Math.pow(2, attempt - 1), max);
    const delay = backoff * (1 + (Math.random() * 2 - 1) * jitter);

    console.info(
      `[BinanceAdapter] reconnecting ${lane} in ${Math.round(delay)}ms (attempt ${attempt})`,
    );
    setTimeout(() => {
      if (!this.disconnecting) {
        if (lane === "spot") {
          this.connectSpot();
        } else {
          this.connectFutures();
        }
      }
    }, delay);
  }

  private handleMessage(raw: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      console.warn("[BinanceAdapter] failed to parse message JSON");
      return;
    }

    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("data" in envelope) ||
      !("stream" in envelope)
    ) {
      return;
    }

    const { stream, data } = envelope as { stream: string; data: unknown };
    const localTimestamp = Date.now();

    if (stream.endsWith("@trade")) {
      this.handleTrade(data, localTimestamp);
    } else if (stream.includes("@depth")) {
      this.handleDepth(data, stream, localTimestamp);
    } else if (stream.endsWith("@markPrice")) {
      this.handleMarkPrice(data, localTimestamp);
    }
  }

  private handleTrade(data: unknown, localTimestamp: number): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;

    const parsed = PriceTickSchema.safeParse({
      exchange: "binance",
      symbol: normalizeSymbol(String(d["s"] ?? "")),
      price: Number(d["p"]),
      quantity: Number(d["q"]),
      side: d["m"] === true ? "sell" : "buy",
      tradeId: String(d["t"] ?? ""),
      timestamp: Number(d["T"]),
      localTimestamp,
    });

    if (!parsed.success) {
      console.warn("[BinanceAdapter] PriceTick parse failed:", parsed.error.issues[0]?.message);
      return;
    }

    for (const cb of this.tickCallbacks) cb(parsed.data);
  }

  private handleDepth(data: unknown, stream: string, _localTimestamp: number): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;

    // Extract symbol from stream name e.g. "btcusdt@depth@100ms"
    const rawSym = stream.split("@")[0] ?? "";
    const symbol = normalizeSymbol(rawSym.toUpperCase());

    const parseTuples = (arr: unknown): [number, number][] => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length < 2) return null;
          return [Number(entry[0]), Number(entry[1])] as [number, number];
        })
        .filter((x): x is [number, number] => x !== null);
    };

    const bids = parseTuples(d["b"] ?? d["bids"]);
    const asks = parseTuples(d["a"] ?? d["asks"]);

    const parsed = OrderBookSnapshotSchema.safeParse({
      exchange: "binance",
      symbol,
      bids,
      asks,
      depth: Math.max(bids.length, asks.length),
      sequenceId: Number(d["u"] ?? d["lastUpdateId"] ?? 0),
      timestamp: Number(d["T"] ?? d["E"] ?? Date.now()),
    });

    if (!parsed.success) {
      console.warn("[BinanceAdapter] OBSnapshot parse failed:", parsed.error.issues[0]?.message);
      return;
    }

    for (const cb of this.obDeltaCallbacks) cb(parsed.data);
  }

  private handleMarkPrice(data: unknown, localTimestamp: number): void {
    if (typeof data !== "object" || data === null) return;
    const d = data as Record<string, unknown>;

    const symbol = normalizeSymbol(String(d["s"] ?? ""));
    const rate = Number(d["r"]);
    const nextFundingTime = Number(d["T"]);

    const parsed = FundingRateSchema.safeParse({
      exchange: "binance",
      symbol,
      rate,
      nextFundingTime,
      timestamp: localTimestamp,
    });

    if (!parsed.success) {
      console.warn("[BinanceAdapter] FundingRate parse failed:", parsed.error.issues[0]?.message);
      return;
    }

    for (const cb of this.fundingRateCallbacks) cb(parsed.data);
  }
}
