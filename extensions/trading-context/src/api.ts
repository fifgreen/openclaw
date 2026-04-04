// Public surface of the trading-context plugin.
// External consumers MUST import from this file only.
// Internal modules MUST NOT be imported by other extensions directly.

export type { MemDirValue, MemDirKey, MemDirTypedKeys } from "./src/memdir/keys.js";
export { createMemDir } from "./src/memdir/MemDir.js";
export type { MemDir, MemDirOptions } from "./src/memdir/MemDir.js";

export type { StrategyOverride } from "./src/engine/StrategyParser.js";
export { parseStrategy } from "./src/engine/StrategyParser.js";

export { createContextEngine } from "./src/engine/ContextEngine.js";
export type {
  ContextEngine,
  ContextEngineOptions,
  AssembledContext,
} from "./src/engine/ContextEngine.js";

export { HaltProtocol } from "./src/halt/HaltProtocol.js";
export type { ExchangeAdapter, CancelResult, CloseResult, HaltReason } from "./src/halt/types.js";
export { recoverFromHalt } from "./src/halt/recovery.js";

export { DecisionJournaler } from "./src/engine/Journaler.js";
export type { JournalEntry } from "./src/engine/Journaler.js";

export { AgentSessionHistory } from "./src/engine/History.js";
export type { HistoryEntry } from "./src/engine/History.js";

export { ensureJournalDir } from "./src/engine/journal-dir.js";
