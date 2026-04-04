// Public surface of the trading-context plugin.
// External consumers MUST import from this file only.
// Internal modules MUST NOT be imported by other extensions directly.

export type { MemDirValue, MemDirKey, MemDirTypedKeys } from "./memdir/keys.js";
export { createMemDir } from "./memdir/MemDir.js";
export type { MemDir, MemDirOptions } from "./memdir/MemDir.js";

export type { StrategyOverride } from "./engine/StrategyParser.js";
export { parseStrategy } from "./engine/StrategyParser.js";

export { createContextEngine } from "./engine/ContextEngine.js";
export type {
  ContextEngine,
  ContextEngineOptions,
  AssembledContext,
} from "./engine/ContextEngine.js";

export { HaltProtocol } from "./halt/HaltProtocol.js";
export type { ExchangeAdapter, CancelResult, CloseResult, HaltReason } from "./halt/types.js";
export { recoverFromHalt } from "./halt/recovery.js";

export { DecisionJournaler } from "./engine/Journaler.js";
export type { JournalEntry } from "./engine/Journaler.js";

export { AgentSessionHistory } from "./engine/History.js";
export type { HistoryEntry } from "./engine/History.js";

export { ensureJournalDir } from "./engine/journal-dir.js";
