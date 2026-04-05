import { describe, it, expect } from "vitest";
import { classifyRegime } from "./regime-classifier.js";

describe("classifyRegime", () => {
  it("risk_off: DXY 105, US10Y 4.8, last hike", () => {
    expect(classifyRegime({ dxy: 105, us10y: 4.8, fomcLastAction: "hike" })).toBe("risk_off");
  });

  it("risk_on: DXY 98, US10Y 3.2", () => {
    expect(classifyRegime({ dxy: 98, us10y: 3.2, fomcLastAction: "hold" })).toBe("risk_on");
  });

  it("neutral: below risk-off thresholds, not risk_on", () => {
    expect(classifyRegime({ dxy: 102, us10y: 4.0, fomcLastAction: "hold" })).toBe("neutral");
  });

  it("uncertain: null DXY", () => {
    expect(classifyRegime({ dxy: null, us10y: 4.8, fomcLastAction: "hike" })).toBe("uncertain");
  });

  it("uncertain: null fomcLastAction", () => {
    expect(classifyRegime({ dxy: 105, us10y: 4.8, fomcLastAction: null })).toBe("uncertain");
  });

  it("custom regimeRules override default thresholds", () => {
    // Lower the risk-off DXY threshold to 100 — should now trigger risk_off at 101
    expect(
      classifyRegime(
        { dxy: 101, us10y: 4.8, fomcLastAction: "hike" },
        { riskOffDxy: 100, riskOffUs10y: 4.0 },
      ),
    ).toBe("risk_off");
  });
});
