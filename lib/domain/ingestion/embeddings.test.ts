import { isMockEmbeddingProvider, mockEmbedding } from "@/lib/domain/ingestion/embeddings";

/**
 * The deterministic offline embedding provider that makes the CI
 * security-eval-gate hermetic.
 *
 * The gate's positive control probes each canary with `embedText` over the
 * canary's OWN content, so the query vector is bit-identical to the stored one
 * and the canary ranks first for any embedding function that is deterministic.
 * Determinism is therefore the whole contract, and it is what these pin.
 */

const ORIGINAL = process.env.EMBEDDING_PROVIDER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EMBEDDING_PROVIDER;
  else process.env.EMBEDDING_PROVIDER = ORIGINAL;
});

describe("isMockEmbeddingProvider", () => {
  it("is off unless explicitly asked for, so no production path can reach it", () => {
    delete process.env.EMBEDDING_PROVIDER;
    expect(isMockEmbeddingProvider()).toBe(false);

    process.env.EMBEDDING_PROVIDER = "gemini";
    expect(isMockEmbeddingProvider()).toBe(false);
  });

  it("is read at call time, not captured at module load", () => {
    // Module-scope capture would make the flag depend on import order, which
    // in a worker process is not something a deployment can reason about.
    process.env.EMBEDDING_PROVIDER = "mock";
    expect(isMockEmbeddingProvider()).toBe(true);

    process.env.EMBEDDING_PROVIDER = "gemini";
    expect(isMockEmbeddingProvider()).toBe(false);
  });

  it("tolerates casing and surrounding whitespace", () => {
    process.env.EMBEDDING_PROVIDER = "  MOCK ";
    expect(isMockEmbeddingProvider()).toBe(true);
  });
});

describe("mockEmbedding", () => {
  it("is deterministic — the property the canary probe depends on", () => {
    const a = mockEmbedding("תקרת החזר הוצאות נסיעה");
    const b = mockEmbedding("תקרת החזר הוצאות נסיעה");
    expect(a).toEqual(b);
  });

  it("ignores surrounding whitespace, matching embedText's trim", () => {
    expect(mockEmbedding("  canary text  ")).toEqual(mockEmbedding("canary text"));
  });

  it("emits exactly the 768 dimensions the schema declares", () => {
    // knowledge_base.embedding is vector(768), and toVectorLiteral rejects
    // anything else before the insert.
    expect(mockEmbedding("x")).toHaveLength(768);
    expect(mockEmbedding("א".repeat(10_000))).toHaveLength(768);
  });

  it("is a unit vector, so it is a legal pgvector cosine operand", () => {
    const v = mockEmbedding("some chunk of text");
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("never emits a degenerate all-zero vector", () => {
    // An all-zero vector has no cosine direction, so it would make the dense
    // leg's ORDER BY meaningless rather than merely arbitrary.
    for (const text of ["", " ", "0", "a", "\u0000", "א"]) {
      const v = mockEmbedding(text);
      expect(v.every((x) => x === 0)).toBe(false);
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it("separates different texts", () => {
    const a = mockEmbedding("L0 canary about donor audits");
    const b = mockEmbedding("L2 public volunteer FAQ");
    expect(a).not.toEqual(b);

    // Cosine similarity of two unrelated hashes should be nowhere near 1, or
    // every chunk would look identical to every query.
    const dot = a.reduce((acc, x, i) => acc + x * b[i]!, 0);
    expect(Math.abs(dot)).toBeLessThan(0.5);
  });
});
