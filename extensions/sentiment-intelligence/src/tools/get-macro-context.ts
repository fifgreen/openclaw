import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { MacroContextSchema, type MacroContext } from "../schema/MacroSnapshot.js";

/**
 * Hot-path macro context reader.
 * Reads from MemDir (key: macro_snapshot, symbol: "*") — no DB or network calls.
 * Returns { error: "not_found" } if the entry is missing or stale (by registry TTL of 24h).
 */
export async function getMacroContext(
  memDir: ReturnType<typeof createMemDir>,
): Promise<MacroContext | { error: "not_found" }> {
  const entry = await memDir.get({ key: "macro_snapshot", symbol: "*" });
  if (!entry) return { error: "not_found" };

  const parsed = MacroContextSchema.safeParse(entry.value);
  if (!parsed.success) return { error: "not_found" };

  return parsed.data;
}

/**
 * Builds an OpenClaw tool descriptor for get_macro_context.
 * The tool reads the latest macro context and regime classification from MemDir.
 */
export function buildGetMacroContextTool(memDir: ReturnType<typeof createMemDir>) {
  return {
    name: "get_macro_context",
    label: "Get Macro Context",
    description:
      "Returns the latest global macro snapshot including DXY, US10Y, oil price, " +
      "M2 supply, BTC dominance, FOMC/CPI calendar dates, and the current market " +
      "regime (risk_on / risk_off / neutral / uncertain). Hot path — reads from " +
      "Redis MemDir, no network calls.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      const data = await getMacroContext(memDir);
      return jsonResult(data);
    },
  };
}
