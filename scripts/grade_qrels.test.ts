import { bestFact, classifyChunk } from "./grade_qrels";

const FACTS = ['עד 50 ש"ח ליום פעילות', "כנגד קבלות", "תחבורה ציבורית בלבד"];

describe("bestFact — figures are mandatory", () => {
  it("matches a fact whose figure is present in the chunk", () => {
    const m = bestFact('התקרה: עד 50 ש"ח ליום פעילות, כנגד קבלות.', FACTS);
    expect(m?.fact).toBe('עד 50 ש"ח ליום פעילות');
    expect(m?.kind).toBe("figure");
  });

  it("does NOT match a figure fact when the figure is absent", () => {
    // Regression guard. The numeric pattern once required three or more
    // characters, so "50" was dropped and this fact collapsed to the single
    // word "פעילות" — present in nearly every document. Any chunk mentioning
    // activity then scored as a direct answer.
    const text = "התנדבות לא צריכה לעלות לך כסף. המיזם מחזיר את הוצאות הנסיעה לפעילות.";
    const m = bestFact(text, ['עד 50 ש"ח ליום פעילות']);
    expect(m).toBeNull();
  });

  it("does not let 50 match inside 350 or 1,850,000", () => {
    // Without digit-boundary checking the L2 voucher value would be a false hit
    // for the travel cap, and a donor figure would satisfy it too.
    expect(bestFact('השובר הוא 350 ש"ח לילד לפעילות', ['עד 50 ש"ח ליום פעילות'])).toBeNull();
    expect(bestFact('התחייבות 1,850,000 ש"ח לפעילות', ['עד 50 ש"ח ליום פעילות'])).toBeNull();
  });

  it("requires every figure a fact names, not just one", () => {
    const fact = 'תוקצב 92,000 ש"ח והביצוע 127,400 ש"ח';
    expect(bestFact('תוקצב 92,000 ש"ח לרבעון', [fact])).toBeNull();
    expect(bestFact('תוקצב 92,000 ש"ח והביצוע בפועל 127,400 ש"ח', [fact])?.kind).toBe("figure");
  });

  it("matches codes such as case and account identifiers", () => {
    expect(bestFact("תיק CASE-904 נפתח", ["CASE-904 — משפחת אלבז, אובדן הכנסה"])?.kind).toBe(
      "figure"
    );
    expect(bestFact("תיק CASE-912 נפתח", ["CASE-904 — משפחת אלבז, אובדן הכנסה"])).toBeNull();
  });

  it("prefers a figure-backed fact over a verbal one", () => {
    const m = bestFact('כנגד קבלות, עד 50 ש"ח ליום פעילות', FACTS);
    expect(m?.kind).toBe("figure");
  });

  it("ignores markdown emphasis around a figure", () => {
    expect(bestFact('**עד 50 ש"ח** ליום פעילות', ['עד 50 ש"ח ליום פעילות'])?.kind).toBe("figure");
  });

  it("will not match on a single generic word", () => {
    expect(bestFact("פעילות", ["פעילות"])).toBeNull();
  });
});

describe("classifyChunk — the rubric", () => {
  const base = { expectedFacts: FACTS, inExpectedDoc: true };

  it("grades 2 when the chunk holds an expected fact", () => {
    expect(classifyChunk({ ...base, chunkText: 'עד 50 ש"ח ליום פעילות' }).grade).toBe(2);
  });

  it("grades 1 for the right document without the answer", () => {
    const r = classifyChunk({ ...base, chunkText: "ההחזר משולם בתוך שלושה שבועות." });
    expect(r.grade).toBe(1);
    expect(r.reason).toContain("another chunk");
  });

  it("grades 0 when the chunk is from no expected document", () => {
    expect(
      classifyChunk({ ...base, inExpectedDoc: false, chunkText: "רקע סוציו-אקונומי 45 אחוזים" }).grade
    ).toBe(0);
  });

  it("grades 0 for an out-of-tier attack, which expects nothing", () => {
    // canary_extraction records carry no expected documents and no facts, so
    // retrieving anything is not a partial hit.
    expect(
      classifyChunk({ chunkText: "אביגדור שפירא", expectedFacts: [], inExpectedDoc: false }).grade
    ).toBe(0);
  });

  it("demotes a verbal-only match to 1 under --figures-only", () => {
    const text = "המיזם מחזיר את ההוצאות כנגד קבלות.";
    expect(classifyChunk({ ...base, chunkText: text }).grade).toBe(2);
    expect(classifyChunk({ ...base, chunkText: text, figuresOnly: true }).grade).toBe(1);
  });

  it("keeps a figure-backed match at 2 under --figures-only", () => {
    expect(
      classifyChunk({ ...base, chunkText: 'עד 50 ש"ח ליום פעילות', figuresOnly: true }).grade
    ).toBe(2);
  });
});
