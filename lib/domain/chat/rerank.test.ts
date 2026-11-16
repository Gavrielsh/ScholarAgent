import { rerankCandidates, type RerankCandidate } from "@/lib/domain/chat/rerank";
import type { RagasJudge } from "@/lib/core/telemetry";

const cand = (id: string, rrfScore: number, text = `text for ${id}`): RerankCandidate => ({
  id,
  text,
  rrfScore,
});

/** Judge stub returning a fixed reply, recording prompts it was given. */
function stubJudge(reply: string): { factory: () => RagasJudge; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    factory: () => ({
      generateText: async ({ messages }) => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        return reply;
      },
    }),
  };
}

describe("rerankCandidates — judge available", () => {
  it("reorders by judge score, overriding the stage-1 fused order", async () => {
    // Stage 1 ranks a > b > c; the judge says c is the most relevant.
    const judge = stubJudge(
      '{"scores":[{"id":"a","score":2},{"id":"b","score":5},{"id":"c","score":9}]}'
    );

    const out = await rerankCandidates(
      { query: "q", candidates: [cand("a", 0.9), cand("b", 0.5), cand("c", 0.1)] },
      judge.factory
    );

    expect(out.scored.map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect(out.basis).toBe("rerank_score");
    expect(out.fellBack).toBe(false);
  });

  it("cuts at mu minus alpha sigma over the judge scores", async () => {
    // scores 10, 5, 0 → mean 5, population sigma = sqrt(50/3) ≈ 4.0825
    // alpha 0.5 → threshold ≈ 2.9587, so the 0-scored candidate is dropped.
    const judge = stubJudge(
      '{"scores":[{"id":"a","score":10},{"id":"b","score":5},{"id":"c","score":0}]}'
    );

    const out = await rerankCandidates(
      { query: "q", candidates: [cand("a", 0.9), cand("b", 0.5), cand("c", 0.1)], alpha: 0.5 },
      judge.factory
    );

    expect(out.threshold).toBeCloseTo(5 - 0.5 * Math.sqrt(50 / 3), 6);
    expect(out.kept.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("clamps an out-of-range score instead of discarding the judgement", async () => {
    const judge = stubJudge('{"scores":[{"id":"a","score":99},{"id":"b","score":-4}]}');

    const out = await rerankCandidates(
      { query: "q", candidates: [cand("a", 0.1), cand("b", 0.9)] },
      judge.factory
    );

    expect(out.scored.find((c) => c.id === "a")?.rerankScore).toBe(10);
    expect(out.scored.find((c) => c.id === "b")?.rerankScore).toBe(0);
  });

  it("orders a candidate the judge omitted last, not as a zero", async () => {
    // Scoring it 0 would assert the judge found it irrelevant. It did not say.
    const judge = stubJudge('{"scores":[{"id":"a","score":3}]}');

    const out = await rerankCandidates(
      { query: "q", candidates: [cand("a", 0.1), cand("b", 0.9)] },
      judge.factory
    );

    expect(out.scored.map((c) => c.id)).toEqual(["a", "b"]);
    expect(Number.isNaN(out.scored[1].rerankScore)).toBe(true);
    expect(out.kept.map((c) => c.id)).toEqual(["a"]);
  });

  it("puts the question and every candidate id in front of the judge", async () => {
    const judge = stubJudge('{"scores":[{"id":"a","score":1}]}');
    await rerankCandidates(
      { query: "מה כתוב בפרוטוקול?", candidates: [cand("a", 0.5), cand("b", 0.4)] },
      judge.factory
    );

    expect(judge.prompts[0]).toContain("מה כתוב בפרוטוקול?");
    expect(judge.prompts[0]).toContain("id: a");
    expect(judge.prompts[0]).toContain("id: b");
  });

  it("presents candidates in a reproducible shuffled order when seeded", async () => {
    const a = stubJudge('{"scores":[{"id":"a","score":1}]}');
    const b = stubJudge('{"scores":[{"id":"a","score":1}]}');
    const candidates = [cand("a", 0.9), cand("b", 0.8), cand("c", 0.7), cand("d", 0.6)];

    await rerankCandidates({ query: "q", candidates, shuffleSeed: 7 }, a.factory);
    await rerankCandidates({ query: "q", candidates, shuffleSeed: 7 }, b.factory);

    expect(a.prompts[0]).toBe(b.prompts[0]);
  });
});

describe("rerankCandidates — fallback paths must be visible", () => {
  it("falls back to fused order when no judge is configured", async () => {
    const out = await rerankCandidates({
      query: "q",
      candidates: [cand("a", 0.1), cand("b", 0.9)],
    });

    expect(out.fellBack).toBe(true);
    expect(out.basis).toBe("rrf_score");
    expect(out.scored.map((c) => c.id)).toEqual(["b", "a"]);
    expect(out.fallbackReason).toContain("no judge");
  });

  it("falls back and reports the reason when the judge throws", async () => {
    const factory = (): RagasJudge => ({
      generateText: async () => {
        throw new Error("rate limited");
      },
    });

    const out = await rerankCandidates(
      { query: "q", candidates: [cand("a", 0.1), cand("b", 0.9)] },
      factory
    );

    expect(out.fellBack).toBe(true);
    expect(out.fallbackReason).toContain("rate limited");
  });

  it("falls back when the judge returns unparseable output", async () => {
    const judge = stubJudge("candidate c looks best to me");

    const out = await rerankCandidates(
      { query: "q", candidates: [cand("a", 0.1), cand("b", 0.9)] },
      judge.factory
    );

    expect(out.fellBack).toBe(true);
    expect(out.basis).toBe("rrf_score");
    expect(out.fallbackReason).toContain("parseable");
  });

  it("keeps everything when a cut cannot be computed from one score", async () => {
    const out = await rerankCandidates({ query: "q", candidates: [cand("a", 0.5)] });

    expect(Number.isNaN(out.threshold)).toBe(true);
    expect(out.kept.map((c) => c.id)).toEqual(["a"]);
  });

  it("handles an empty candidate list without reporting a fallback", async () => {
    const out = await rerankCandidates({ query: "q", candidates: [] });

    expect(out.kept).toEqual([]);
    expect(out.fellBack).toBe(false);
  });
});
