import fs from "node:fs/promises";
import path from "node:path";
import { ensureJournalDir } from "./journal-dir.js";

// ---------------------------------------------------------------------------
// Journal entry types
// ---------------------------------------------------------------------------

export interface TickJournalEntry {
  type: "tick";
  sessionId: string;
  symbol: string;
  timestamp: number;
  /** Snapshot of all MemDir values at decision time. */
  memDirSnapshot: Record<string, unknown>;
  /** The strategy override active at tick time. */
  strategyId: string;
  /** Active quant signals — populated by external ingestion (Phase 1). */
  quantSignals: Record<string, unknown>;
  /** Final reasoning from the LLM. */
  reasoning: string;
  /** Action taken: "buy" | "sell" | "hold" | "close". */
  action: string;
}

export interface HaltJournalEntry {
  type: "halt";
  sessionId: string;
  symbol: string;
  timestamp: number;
  triggeredAt: number;
  reason: string;
  message: string;
  canceledOrderIds: string[];
  closedPositions: Array<{ positionId: string; closedAt: number; price: number }>;
  cancelErrors: string[];
  closeErrors: string[];
  memDirSnapshot: Record<string, unknown>;
}

export type JournalEntry = TickJournalEntry | HaltJournalEntry;

// ---------------------------------------------------------------------------
// DecisionJournaler
// ---------------------------------------------------------------------------

export class DecisionJournaler {
  private readonly journalDir: string;
  private readonly sessionId: string;
  private initialized = false;

  constructor(opts: { journalDir: string; sessionId: string }) {
    this.journalDir = opts.journalDir;
    this.sessionId = opts.sessionId;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await ensureJournalDir(this.journalDir);
    this.initialized = true;
  }

  private journalFilePath(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return path.join(this.journalDir, `${year}-${month}.jsonl`);
  }

  private async append(entry: JournalEntry): Promise<void> {
    await this.init();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.journalFilePath(), line, "utf-8");
  }

  async writeTick(
    params: Omit<TickJournalEntry, "type" | "sessionId" | "timestamp">,
  ): Promise<void> {
    await this.append({
      type: "tick",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...params,
    });
  }

  async writeHalt(
    params: Omit<HaltJournalEntry, "type" | "sessionId" | "timestamp">,
  ): Promise<void> {
    await this.append({
      type: "halt",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...params,
    });
  }
}

// ---------------------------------------------------------------------------
// Query helpers (used by plugin tools)
// ---------------------------------------------------------------------------

/**
 * Read the N most recent journal entries from the current month's JSONL file.
 * Returns entries in reverse-chronological order (newest first).
 */
export async function readRecentJournalEntries(
  journalDir: string,
  limit: number,
): Promise<JournalEntry[]> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const filePath = path.join(journalDir, `${year}-${month}.jsonl`);

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  // Take the last `limit` lines (most recent) and parse
  const recent = lines.slice(-limit).reverse();
  const entries: JournalEntry[] = [];
  for (const line of recent) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}
