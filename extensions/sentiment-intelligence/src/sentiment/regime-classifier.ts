import type { MacroContext } from "../schema/MacroSnapshot.js";

export interface RegimeRules {
  riskOffDxy: number;
  riskOffUs10y: number;
  riskOffFomcAction: "hike";
  riskOnDxy: number;
  riskOnUs10y: number;
}

const DEFAULT_RULES: RegimeRules = {
  riskOffDxy: 104,
  riskOffUs10y: 4.5,
  riskOffFomcAction: "hike",
  riskOnDxy: 100,
  riskOnUs10y: 3.5,
};

export type RegimeClassification = "risk_on" | "risk_off" | "neutral" | "uncertain";

/**
 * Classifies the macroeconomic regime based on DXY, US10Y, and FOMC action.
 * Returns "uncertain" if any required field is missing.
 */
export function classifyRegime(
  macro: Partial<MacroContext>,
  rules: Partial<RegimeRules> = {},
): RegimeClassification {
  const r = { ...DEFAULT_RULES, ...rules };

  if (macro.dxy == null || macro.us10y == null || macro.fomcLastAction == null) {
    return "uncertain";
  }

  if (
    macro.dxy > r.riskOffDxy &&
    macro.us10y > r.riskOffUs10y &&
    macro.fomcLastAction === r.riskOffFomcAction
  ) {
    return "risk_off";
  }

  if (macro.dxy < r.riskOnDxy && macro.us10y < r.riskOnUs10y) {
    return "risk_on";
  }

  return "neutral";
}
