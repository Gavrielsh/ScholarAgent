import {
  adaptiveThreshold,
  meanStd,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank,
  type RelevanceGrade,
} from "@/lib/core/irMetrics";

/** a fully relevant, b irrelevant, c partial, d fully relevant but never retrieved. */
const JUDGED = new Map<string, RelevanceGrade>([
  ["a", 2],
  ["b", 0],
  ["c", 1],
  ["d", 2],
]);

const NO_RELEVANT = new Map<string, RelevanceGrade>([["x", 0], ["y", 0]]);

describe("recallAtK", () => {
  it("counts relevant hits against every relevant chunk that exists", () => {
    // relevant = {a, c, d} = 3. Top 3 of [a,b,c] contains a and c.
    expect(recallAtK(["a", "b", "c"], JUDGED, 3)).toBeCloseTo(2 / 3, 10);
  });

  it("respects the cutoff", () => {
    // Top 1 of [a,b,c] contains only a.
    expect(recallAtK(["a", "b", "c"], JUDGED, 1)).toBeCloseTo(1 / 3, 10);
  });

  it("treats grade 1 as relevant, so partial matches count", () => {
    expect(recallAtK(["c"], JUDGED, 5)).toBeCloseTo(1 / 3, 10);
  });

  it("does not count a duplicated chunk id twice", () => {
    // A fusion bug that emitted the same id twice could otherwise report 2/3.
    expect(recallAtK(["a", "a", "a"], JUDGED, 3)).toBeCloseTo(1 / 3, 10);
  });

  it("reports NaN, not zero, when the query has no relevant chunks", () => {
    // 0 would read as "retrieved none of them" rather than "there were none".
    expect(Number.isNaN(recallAtK(["x", "y"], NO_RELEVANT, 3))).toBe(true);
  });

  it("is zero when relevant chunks exist and none were retrieved", () => {
    expect(recallAtK(["b"], JUDGED, 3)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("is 1 when the first result is relevant", () => {
    expect(reciprocalRank(["a", "b", "c"], JUDGED)).toBe(1);
  });

  it("is 1/2 when the first relevant result is second", () => {
    expect(reciprocalRank(["b", "c", "a"], JUDGED)).toBe(0.5);
  });

  it("is zero when nothing relevant was retrieved at all", () => {
    expect(reciprocalRank(["b"], JUDGED)).toBe(0);
  });

  it("is NaN when the query has nothing relevant to find", () => {
    expect(Number.isNaN(reciprocalRank(["x"], NO_RELEVANT))).toBe(true);
  });
});

describe("ndcgAtK", () => {
  it("matches the hand-computed value for graded relevance", () => {
    // retrieved [a(2), b(0), c(1)]
    //   DCG@3  = 3/log2(2) + 0/log2(3) + 1/log2(4) = 3 + 0 + 0.5      = 3.5
    // ideal grades desc [2, 2, 1]
    //   IDCG@3 = 3/log2(2) + 3/log2(3) + 1/log2(4) = 3 + 1.8927892607 + 0.5
    //                                              = 5.3927892607
    //   NDCG@3 = 3.5 / 5.3927892607                = 0.6490147919
    expect(ndcgAtK(["a", "b", "c"], JUDGED, 3)).toBeCloseTo(0.6490147919, 9);
  });

  it("is 1 when the ranking is already ideal at the cutoff", () => {
    const j = new Map<string, RelevanceGrade>([["p", 2], ["q", 1]]);
    expect(ndcgAtK(["p", "q"], j, 2)).toBeCloseTo(1, 10);
  });

  it("penalises putting the weaker match first", () => {
    const j = new Map<string, RelevanceGrade>([["p", 2], ["q", 1]]);
    const ideal = ndcgAtK(["p", "q"], j, 2);
    const swapped = ndcgAtK(["q", "p"], j, 2);
    expect(swapped).toBeLessThan(ideal);
    // DCG = 1/1 + 3/log2(3) = 2.8927892607
    // IDCG = 3/1 + 1/log2(3) = 3.6309297536 → 0.7967075810
    expect(swapped).toBeCloseTo(0.796707581, 9);
  });

  it("separates a grade-2 hit from a grade-1 hit at the same rank", () => {
    const strong = new Map<string, RelevanceGrade>([["p", 2]]);
    const weak = new Map<string, RelevanceGrade>([["p", 1]]);
    // Both are ideal against their own judgements, so both are 1 — the point is
    // that gain differs, which only shows up when ranked against other grades.
    expect(ndcgAtK(["p"], strong, 1)).toBeCloseTo(1, 10);
    expect(ndcgAtK(["p"], weak, 1)).toBeCloseTo(1, 10);
  });

  it("is NaN when the query has nothing relevant to find", () => {
    expect(Number.isNaN(ndcgAtK(["x"], NO_RELEVANT, 5))).toBe(true);
  });
});

describe("percentile — nearest-rank, no interpolation", () => {
  const xs = [10, 20, 30, 40, 50];

  it("returns an observed sample for P50", () => {
    // ceil(0.50 × 5) = 3 → index 2 → 30
    expect(percentile(xs, 50)).toBe(30);
  });

  it("returns an observed sample for P95", () => {
    // ceil(0.95 × 5) = 5 → index 4 → 50
    expect(percentile(xs, 95)).toBe(50);
  });

  it("sorts before indexing", () => {
    expect(percentile([50, 10, 40, 20, 30], 50)).toBe(30);
  });

  it("is NaN over an empty sample", () => {
    expect(Number.isNaN(percentile([], 95))).toBe(true);
  });

  it("ignores non-finite samples rather than sorting them to an end", () => {
    expect(percentile([10, NaN, 20, 30, 40, 50], 50)).toBe(30);
  });
});

describe("meanStd", () => {
  it("computes the population standard deviation", () => {
    // mean 5; squared deviations 9,1,1,1,0,0,4,16 = 32; 32/8 = 4; sqrt = 2
    expect(meanStd([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, std: 2, n: 8 });
  });

  it("reports std 0 for a single sample and says so via n", () => {
    // Legitimately 0, but n=1 is what tells the reader it means nothing.
    expect(meanStd([42])).toEqual({ mean: 42, std: 0, n: 1 });
  });

  it("excludes NaN samples instead of counting them as zero", () => {
    expect(meanStd([4, NaN, 6])).toEqual({ mean: 5, std: 1, n: 2 });
  });

  it("is NaN over an empty sample", () => {
    const r = meanStd([]);
    expect(Number.isNaN(r.mean)).toBe(true);
    expect(r.n).toBe(0);
  });
});

describe("adaptiveThreshold", () => {
  it("cuts at mu minus alpha sigma", () => {
    // mean 5, std 2 → 5 − 1×2 = 3
    expect(adaptiveThreshold([2, 4, 4, 4, 5, 5, 7, 9], 1)).toBeCloseTo(3, 10);
  });

  it("scales with alpha", () => {
    expect(adaptiveThreshold([2, 4, 4, 4, 5, 5, 7, 9], 0.5)).toBeCloseTo(4, 10);
  });

  it("is NaN for fewer than two scores, where sigma is undefined", () => {
    expect(Number.isNaN(adaptiveThreshold([0.5], 1))).toBe(true);
    expect(Number.isNaN(adaptiveThreshold([], 1))).toBe(true);
  });
});
