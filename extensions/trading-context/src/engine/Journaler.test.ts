import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DecisionJournaler } from "./Journaler.js";

// ---------------------------------------------------------------------------
// Setup: use a temp directory for journal files
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-context-journal-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T017a: Journal entry captures all required fields
// ---------------------------------------------------------------------------

describe("DecisionJournaler — tick entries", () => {
  it("writes all required fields for a tick decision", async () => {
    const journaler = new DecisionJournaler({ journalDir: tempDir, sessionId: "s1" });

    await journaler.writeTick({
      symbol: "btc",
      memDirSnapshot: {
        macro_regime: "risk-on",
        fear_greed: { score: 72, classification: "Greed" },
      },
      strategyId: "btc-trend-v1",
      quantSignals: { rsi: 54.2, vwap: 42100 },
      reasoning: "RSI above 50, macro risk-on, confluence met. Decision: BUY.",
      action: "buy",
    });

    const files = await fs.readdir(tempDir);
    expect(files.length).toBe(1);

    const content = await fs.readFile(path.join(tempDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.type).toBe("tick");
    expect(entry.sessionId).toBe("s1");
    expect(entry.symbol).toBe("btc");
    expect(entry.strategyId).toBe("btc-trend-v1");
    expect(entry.action).toBe("buy");
    expect(entry.reasoning).toContain("BUY");
    expect(entry.memDirSnapshot?.macro_regime).toBe("risk-on");
    expect(entry.quantSignals?.rsi).toBe(54.2);
    expect(typeof entry.timestamp).toBe("number");
  });

  it("appends multiple entries to the same JSONL file", async () => {
    const journaler = new DecisionJournaler({ journalDir: tempDir, sessionId: "s2" });

    for (let i = 0; i < 5; i++) {
      await journaler.writeTick({
        symbol: "btc",
        memDirSnapshot: {},
        strategyId: "btc-trend-v1",
        quantSignals: {},
        reasoning: `Tick ${i}: HOLD`,
        action: "hold",
      });
    }

    const files = await fs.readdir(tempDir);
    const content = await fs.readFile(path.join(tempDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(5);

    // Each line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// T017b: Halt events are journaled with full context
// ---------------------------------------------------------------------------

describe("DecisionJournaler — halt entries", () => {
  it("writes all required fields for a halt event", async () => {
    const journaler = new DecisionJournaler({ journalDir: tempDir, sessionId: "s3" });

    await journaler.writeHalt({
      symbol: "btc",
      reason: "invalid_strategy",
      message: "Zod validation failed for strategy JSON",
      triggeredAt: Date.now(),
      canceledOrderIds: ["ord-1", "ord-2"],
      closedPositions: [{ positionId: "pos-1", closedAt: Date.now(), price: 42000 }],
      cancelErrors: [],
      closeErrors: [],
      memDirSnapshot: { trading_halted: { halted: true } },
    });

    const files = await fs.readdir(tempDir);
    const content = await fs.readFile(path.join(tempDir, files[0]!), "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.type).toBe("halt");
    expect(entry.reason).toBe("invalid_strategy");
    expect(entry.canceledOrderIds).toEqual(["ord-1", "ord-2"]);
    expect(entry.closedPositions.length).toBe(1);
    expect(entry.closedPositions[0].positionId).toBe("pos-1");
    expect(entry.memDirSnapshot?.trading_halted?.halted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T017c: JSONL format validity
// ---------------------------------------------------------------------------

describe("DecisionJournaler — JSONL format", () => {
  it("every line is independently parseable JSON", async () => {
    const journaler = new DecisionJournaler({ journalDir: tempDir, sessionId: "s4" });

    await journaler.writeTick({
      symbol: "btc",
      memDirSnapshot: {},
      strategyId: "t1",
      quantSignals: {},
      reasoning: "HOLD",
      action: "hold",
    });
    await journaler.writeHalt({
      symbol: "btc",
      reason: "consecutive_timeouts",
      message: "3 timeouts",
      triggeredAt: Date.now(),
      canceledOrderIds: [],
      closedPositions: [],
      cancelErrors: [],
      closeErrors: [],
      memDirSnapshot: {},
    });
    await journaler.writeTick({
      symbol: "btc",
      memDirSnapshot: {},
      strategyId: "t1",
      quantSignals: {},
      reasoning: "BUY",
      action: "buy",
    });

    const files = await fs.readdir(tempDir);
    const content = await fs.readFile(path.join(tempDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(3);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual(["tick", "halt", "tick"]);
  });

  it("ensureJournalDir creates nested directories on first write", async () => {
    const nestedDir = path.join(tempDir, "training", "trades");
    const journaler = new DecisionJournaler({ journalDir: nestedDir, sessionId: "s5" });

    await journaler.writeTick({
      symbol: "eth",
      memDirSnapshot: {},
      strategyId: "eth-v1",
      quantSignals: {},
      reasoning: "HOLD",
      action: "hold",
    });

    const stat = await fs.stat(nestedDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
