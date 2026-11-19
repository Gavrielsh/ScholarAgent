import { buildLexicalSearchExpression } from "@/lib/core/db";

/**
 * Regression tests for the bug that made the sparse arm score 0.000 on every
 * metric and silently reduced hybrid retrieval to dense-only.
 */
describe("buildLexicalSearchExpression", () => {
  it("joins terms with OR, not AND", () => {
    // AND was the bug: a 13-token question required all 13 lexemes in one
    // chunk, so the leg returned zero rows for every real query.
    expect(buildLexicalSearchExpression("תקרה יומית החזר")).toBe("תקרה OR יומית OR החזר");
  });

  it("handles a full question the way a user would actually ask it", () => {
    const expr = buildLexicalSearchExpression(
      "מה התקרה היומית להחזר הוצאות נסיעה למתנדב, ועד מתי צריך להגיש את הבקשה?"
    );
    expect(expr).not.toBeNull();
    expect(expr!.split(" OR ").length).toBeGreaterThan(5);
    expect(expr).not.toContain(",");
    expect(expr).not.toContain("?");
  });

  it("strips quotes, which Hebrew currency writing makes routine", () => {
    // ש"ח carries a double quote; left in place it opens a phrase and changes
    // how the whole expression parses.
    const expr = buildLexicalSearchExpression('תקרה 50 ש"ח ליום');
    expect(expr).not.toContain('"');
    expect(expr).toContain("תקרה");
  });

  it("splits a hyphenated word but never emits a leading dash", () => {
    // A leading dash negates the term in websearch syntax.
    const expr = buildLexicalSearchExpression("סוציו-אקונומי רקע");
    expect(expr!.split(" OR ").every((t) => !t.startsWith("-"))).toBe(true);
    expect(expr).toContain("אקונומי");
  });

  it("drops the words websearch treats as operators", () => {
    const expr = buildLexicalSearchExpression("budget or travel and expenses not frozen");
    expect(expr!.split(" OR ")).toEqual(["budget", "travel", "expenses", "frozen"]);
  });

  it("de-duplicates repeated terms", () => {
    expect(buildLexicalSearchExpression("תקציב תקציב נסיעות")).toBe("תקציב OR נסיעות");
  });

  it("drops single characters, which match almost everything", () => {
    const expr = buildLexicalSearchExpression("א ב תקציב");
    expect(expr).toBe("תקציב");
  });

  it("caps the term count so one long query cannot dominate", () => {
    const many = Array.from({ length: 60 }, (_, i) => `term${i}`).join(" ");
    expect(buildLexicalSearchExpression(many)!.split(" OR ")).toHaveLength(24);
  });

  it("returns null when nothing searchable survives", () => {
    // The caller then skips the leg rather than issuing a query that cannot match.
    expect(buildLexicalSearchExpression("")).toBeNull();
    expect(buildLexicalSearchExpression("   ")).toBeNull();
    expect(buildLexicalSearchExpression("?!,.")).toBeNull();
    expect(buildLexicalSearchExpression("or and not")).toBeNull();
  });

  it("keeps a figure's separators, so 4,500 stays one term", () => {
    // Splitting on the comma produced "4" and "500", then dropped "4" as a
    // single character — destroying the term that distinguishes the L1 monthly
    // cap from the fast-track ceiling and the per-trip limit.
    expect(buildLexicalSearchExpression("תקציב 4,500 לחודש")).toBe("תקציב OR 4,500 OR לחודש");
  });

  it("keeps a phone number and a date intact", () => {
    expect(buildLexicalSearchExpression("מוקד 03-5550199")).toBe("מוקד OR 03-5550199");
    expect(buildLexicalSearchExpression("בתאריך 2026-11-18")).toContain("2026-11-18");
  });

  it("distinguishes the three reimbursement figures from one another", () => {
    // 250, 2,500 and 4,500 must each survive as themselves.
    for (const [q, want] of [["עד 250", "250"], ["עד 2,500", "2,500"], ["תקרה 4,500", "4,500"]] as const) {
      expect(buildLexicalSearchExpression(q)!.split(" OR ")).toContain(want);
    }
  });
});
