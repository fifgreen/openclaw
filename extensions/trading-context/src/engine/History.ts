// Per-session conversation ledger tracking inference iterations,
// tool calls, and MemDir state variables at each tick.

export type HistoryRole = "user" | "assistant" | "tool";

export interface HistoryEntry {
  role: HistoryRole;
  content: string;
  timestamp: number;
  /** Tool call name if this entry is a tool invocation or result. */
  toolName?: string;
  /** Snapshot of MemDir values at this tick. */
  memDirSnapshot?: Record<string, unknown>;
}

export class AgentSessionHistory {
  private readonly entries: HistoryEntry[] = [];
  readonly sessionId: string;
  readonly symbol: string;

  constructor(opts: { sessionId: string; symbol: string }) {
    this.sessionId = opts.sessionId;
    this.symbol = opts.symbol;
  }

  /** Append an entry to the history ledger. */
  push(entry: HistoryEntry): void {
    this.entries.push(entry);
  }

  /** Return all entries (defensive copy). */
  getAll(): HistoryEntry[] {
    return [...this.entries];
  }

  /** Return the most recent N entries. */
  getRecent(n: number): HistoryEntry[] {
    return this.entries.slice(-n);
  }

  /** Return the last decision entry (role=assistant). */
  getLastDecision(): HistoryEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.role === "assistant") return this.entries[i]!;
    }
    return null;
  }

  /** Number of entries in the ledger. */
  get length(): number {
    return this.entries.length;
  }
}
