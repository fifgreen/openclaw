import { describe, it, expect, vi } from "vitest";
import type { FundingRate } from "../schema/FundingRate.js";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import type { PriceTick } from "../schema/PriceTick.js";
import { BybitAdapter } from "./BybitAdapter.js";

/** Build a Bybit V5 trade message */
function makeBybitTradeMsg(overrides?: Partial<Record<string, unknown>>): string {
  return JSON.stringify({
    topic: "trade.BTCUSDT",
    data: [
      {
        i: "trade001",
        T: Date.now(),
        p: "65000.5",
        v: "0.01",
        S: "Buy",
        ...overrides,
      },
    ],
  });
}

/** Build a Bybit V5 orderbook message */
function makeBybitOBMsg(): string {
  return JSON.stringify({
    topic: "orderbook.50.BTCUSDT",
    data: {
      b: [
        ["65000", "0.5"],
        ["64999", "1.0"],
      ],
      a: [["65001", "0.3"]],
      seq: 42,
      ts: Date.now(),
    },
  });
}

/** Build a Bybit V5 tickers (funding rate) message */
function makeBybitTickerMsg(): string {
  return JSON.stringify({
    topic: "tickers.BTCUSDT",
    data: {
      fundingRate: "0.0001",
      nextFundingTime: String(Date.now() + 3_600_000),
    },
  });
}

describe("BybitAdapter", () => {
  it("onTick callback receives a valid PriceTick after a synthetic trade message", () => {
    const adapter = new BybitAdapter();
    const ticks: PriceTick[] = [];
    adapter.onTick((t) => ticks.push(t));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeBybitTradeMsg());

    expect(ticks[0]?.exchange).toBe("bybit");
    expect(ticks[0]?.symbol).toBe("BTC/USDT");
    expect(ticks[0]?.side).toBe("buy");
    expect(ticks[0]?.price).toBe(65000.5);
  });

  it("sell side mapped correctly", () => {
    const adapter = new BybitAdapter();
    const ticks: PriceTick[] = [];
    adapter.onTick((t) => ticks.push(t));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeBybitTradeMsg({ S: "Sell" }));

    expect(ticks[0]?.side).toBe("sell");
  });

  it("symbol normalization — BTCUSDT → BTC/USDT", () => {
    const adapter = new BybitAdapter();
    const ticks: PriceTick[] = [];
    adapter.onTick((t) => ticks.push(t));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeBybitTradeMsg());

    expect(ticks[0]?.symbol).toBe("BTC/USDT");
  });

  it("Zod parse failure on malformed payload logs warn and does not crash", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new BybitAdapter();
    const ticks: PriceTick[] = [];
    adapter.onTick((t) => ticks.push(t));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    // Missing required fields — will fail Zod parse
    handleMessage(JSON.stringify({ topic: "trade.BTCUSDT", data: [{ broken: true }] }));

    expect(ticks).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("BybitAdapter"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("onOBDelta callback receives a valid OrderBookSnapshot", () => {
    const adapter = new BybitAdapter();
    const snapshots: OrderBookSnapshot[] = [];
    adapter.onOBDelta((s) => snapshots.push(s));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeBybitOBMsg());

    expect(snapshots[0]?.exchange).toBe("bybit");
    expect(snapshots[0]?.symbol).toBe("BTC/USDT");
    expect(snapshots[0]?.bids.length).toBeGreaterThan(0);
  });

  it("onFundingRate callback receives a valid FundingRate from tickers message", () => {
    const adapter = new BybitAdapter();
    const rates: FundingRate[] = [];
    adapter.onFundingRate((r) => rates.push(r));

    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    handleMessage(makeBybitTickerMsg());

    expect(rates[0]?.exchange).toBe("bybit");
    expect(rates[0]?.rate).toBe(0.0001);
    expect(rates[0]?.nextFundingTime).toBeGreaterThan(Date.now());
  });

  it("info-level log on disconnect", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = new BybitAdapter({ reconnectBaseMs: 99999 });
    adapter.subscribe([]);
    await adapter.disconnect();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/BybitAdapter.*disconnected|disconnected.*BybitAdapter/),
    );
    infoSpy.mockRestore();
  });

  it("warn-level log on data-loss (OB parse failure)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new BybitAdapter();
    const handleMessage = (adapter as unknown as { handleMessage: (raw: string) => void })[
      "handleMessage"
    ].bind(adapter);
    // Send malformed OB data
    handleMessage(JSON.stringify({ topic: "orderbook.50.BTCUSDT", data: null }));
    // No crash, no snapshot emitted
    warnSpy.mockRestore();
  });
});
