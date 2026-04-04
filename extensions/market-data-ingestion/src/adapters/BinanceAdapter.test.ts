import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import type { PriceTick } from "../schema/PriceTick.js";
import { BinanceAdapter } from "./BinanceAdapter.js";

/** Build a minimal Binance combined-stream trade envelope */
function makeTradeMsg(overrides?: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    stream: "btcusdt@trade",
    data: {
      s: "BTCUSDT",
      p: "65000.5",
      q: "0.01",
      m: false, // taker side = buy
      t: 99999,
      T: Date.now(),
      ...overrides,
    },
  });
}

/** Build a minimal depth update envelope */
function makeDepthMsg(): string {
  return JSON.stringify({
    stream: "btcusdt@depth@100ms",
    data: {
      s: "BTCUSDT",
      b: [
        ["65000", "0.5"],
        ["64999", "1.0"],
      ],
      a: [["65001", "0.3"]],
      u: 42,
      T: Date.now(),
    },
  });
}

describe("BinanceAdapter", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("onTick callback receives a valid PriceTick after a synthetic trade message", async () => {
    const adapter = new BinanceAdapter() as unknown as {
      connectSpot: () => void;
      symbols: string[];
      tickCallbacks: Array<(t: PriceTick) => void>;
    } & BinanceAdapter;
    adapter.subscribe(["BTC/USDT"]);

    const tickReceived = new Promise<PriceTick>((resolve) => {
      adapter.onTick((tick) => resolve(tick));
    });

    // Inject a WS server that sends one trade message on connect
    wss.on("connection", (client) => {
      client.send(makeTradeMsg());
    });

    // Patch the spot URL to point at our test server
    const ws = await import("ws");
    const origWS = ws.default;
    const MockWS = class extends origWS {
      constructor(url: string | URL) {
        // Redirect both spot and futures URLs to our test server
        super(`ws://localhost:${port}`);
      }
    };
    (adapter as unknown as Record<string, unknown>)["connectSpot"] = () => {
      // use the patched URL
    };

    // Simpler approach: directly call handleMessage
    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeTradeMsg());

    const tick = await tickReceived;
    expect(tick.exchange).toBe("binance");
    expect(tick.symbol).toBe("BTC/USDT");
    expect(tick.price).toBe(65000.5);
    expect(tick.side).toBe("buy");
  });

  it("symbol normalization — BTCUSDT → BTC/USDT", () => {
    const adapter = new BinanceAdapter();
    const ticks: PriceTick[] = [];
    adapter.onTick((t) => ticks.push(t));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeTradeMsg());

    expect(ticks[0]?.symbol).toBe("BTC/USDT");
  });

  it("Zod parse failure on malformed payload logs warn and does not crash", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new BinanceAdapter();
    const ticks: PriceTick[] = [];
    adapter.onTick((t) => ticks.push(t));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    // Missing required fields — will fail Zod parse
    handleMessage(JSON.stringify({ stream: "btcusdt@trade", data: { s: "BTCUSDT" } }));

    expect(ticks).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("BinanceAdapter"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("onOBDelta callback receives a valid OrderBookSnapshot", () => {
    const adapter = new BinanceAdapter();
    const snapshots: OrderBookSnapshot[] = [];
    adapter.onOBDelta((s) => snapshots.push(s));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeDepthMsg());

    expect(snapshots[0]?.exchange).toBe("binance");
    expect(snapshots[0]?.bids.length).toBeGreaterThan(0);
  });

  it("info-level log on connect/disconnect events", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = new BinanceAdapter({ reconnectBaseMs: 99999 });
    adapter.subscribe([]);
    // Disconnect immediately without connecting real WS
    await adapter.disconnect();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/BinanceAdapter.*disconnected|disconnected.*BinanceAdapter/),
    );
    infoSpy.mockRestore();
  });
});
