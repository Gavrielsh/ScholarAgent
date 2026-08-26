import {
  classifySafetySignals,
  containsMandatoryHandoffSignals,
  MANDATORY_HANDOFF_RESPONSE_HE,
  PRIVACY_BLOCK_RESPONSE_HE,
} from "@/lib/security/guardrails";

describe("classifySafetySignals", () => {
  it("classifies a valid educational query with zero risk", () => {
    const result = classifySafetySignals("איך לתכנן שיעור על חברות ואמפתיה בכיתה?");

    expect(result.intentCategory).toBe("VALID_EDUCATIONAL");
    expect(result.safetyRiskScore).toBe(0);
    expect(result.rewrittenQuery).toBeNull();
    expect(result.finalResponse).toBeUndefined();
  });

  it("triggers mandatory handoff for distress patterns", () => {
    const query = "אני רוצה למות ולא יודע למי לפנות";
    const result = classifySafetySignals(query);

    expect(containsMandatoryHandoffSignals(query)).toBe(true);
    expect(result.intentCategory).toBe("PROBLEMATIC");
    expect(result.safetyRiskScore).toBe(100);
    expect(result.finalResponse).toBe(MANDATORY_HANDOFF_RESPONSE_HE);
    expect(result.rewrittenQuery).toBeNull();
  });

  it("blocks privacy violations when personal data is requested", () => {
    const result = classifySafetySignals("פרטים על ילד בכיתה");

    expect(result.intentCategory).toBe("PROBLEMATIC");
    expect(result.safetyRiskScore).toBeGreaterThanOrEqual(55);
    expect(result.finalResponse).toBe(PRIVACY_BLOCK_RESPONSE_HE);
  });
});
