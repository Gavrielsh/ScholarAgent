import { detectKnowledgeGap, maxSimilarity } from "@/lib/domain/chat/knowledgeGaps";
import {
  CHIT_CHAT_INVARIANT_HE,
  INSUFFICIENT_CONTEXT_REPLY_HE,
  OUT_OF_DOMAIN_REPLY_HE,
} from "@/lib/domain/chat/rag";

const chunk = (similarity: number) => ({ similarity });

describe("detectKnowledgeGap — what counts as a gap", () => {
  it("flags the model's own declaration that the corpus was insufficient", () => {
    expect(
      detectKnowledgeGap({
        answer: INSUFFICIENT_CONTEXT_REPLY_HE,
        retrievedChunks: [chunk(0.71), chunk(0.64)],
      })
    ).toBe("model_declared_insufficient");
  });

  it("outranks empty retrieval, because it is a judgement and not a proxy", () => {
    // Five chunks came back and the model still said none of them answered the
    // question. No retrieval-side signal can detect that.
    expect(
      detectKnowledgeGap({
        answer: `${INSUFFICIENT_CONTEXT_REPLY_HE}.`,
        retrievedChunks: [chunk(0.9), chunk(0.88), chunk(0.85), chunk(0.8), chunk(0.79)],
      })
    ).toBe("model_declared_insufficient");
  });

  it("flags an answer produced with nothing retrieved", () => {
    expect(
      detectKnowledgeGap({
        answer: "כדאי לשוחח עם הילד בנפרד ולהציע לו תפקיד בטוח בפעילות.",
        retrievedChunks: [],
      })
    ).toBe("empty_retrieval");
  });

  it("does not flag a normal grounded answer", () => {
    expect(
      detectKnowledgeGap({
        answer: "לפי הנוהל, יש להפריד בין הניצים ולשוחח עם כל אחד בנפרד.",
        retrievedChunks: [chunk(0.82)],
      })
    ).toBeNull();
  });
});

describe("detectKnowledgeGap — exclusions that keep the table usable", () => {
  it("never files a greeting as a missing document", () => {
    // A greeting retrieves nothing, so without this exclusion every "שלום"
    // becomes a knowledge gap and the table fills with noise.
    expect(
      detectKnowledgeGap({
        answer: `שלום דנה! ${CHIT_CHAT_INVARIANT_HE}`,
        retrievedChunks: [],
      })
    ).toBeNull();
  });

  it("excludes the greeting whoever it is addressed to", () => {
    for (const name of ["ליאור", "חבר/ה", "יוסי כהן"]) {
      expect(
        detectKnowledgeGap({
          answer: `שלום ${name}! ${CHIT_CHAT_INVARIANT_HE}`,
          retrievedChunks: [],
        })
      ).toBeNull();
    }
  });

  it("never files an out-of-domain question as a missing document", () => {
    expect(
      detectKnowledgeGap({
        answer: OUT_OF_DOMAIN_REPLY_HE,
        retrievedChunks: [],
      })
    ).toBeNull();
  });

  it("lets the exclusions win even when retrieval was empty", () => {
    // Precedence check: both exclusions are evaluated before empty_retrieval.
    expect(
      detectKnowledgeGap({ answer: CHIT_CHAT_INVARIANT_HE, retrievedChunks: [] })
    ).toBeNull();
    expect(
      detectKnowledgeGap({ answer: OUT_OF_DOMAIN_REPLY_HE, retrievedChunks: [] })
    ).toBeNull();
  });
});

describe("detectKnowledgeGap — tolerant matching", () => {
  it("absorbs the whitespace a model adds around a verbatim reply", () => {
    expect(
      detectKnowledgeGap({
        answer: `  ${INSUFFICIENT_CONTEXT_REPLY_HE.replace(" ", "\n ")}  `,
        retrievedChunks: [chunk(0.5)],
      })
    ).toBe("model_declared_insufficient");
  });

  it("is not defeated by bidi marks around the Hebrew run", () => {
    expect(
      detectKnowledgeGap({
        answer: `‏${INSUFFICIENT_CONTEXT_REPLY_HE}‎`,
        retrievedChunks: [chunk(0.5)],
      })
    ).toBe("model_declared_insufficient");
  });

  it("still matches when the model wraps the reply in a sentence", () => {
    expect(
      detectKnowledgeGap({
        answer: `מצטער, ${INSUFFICIENT_CONTEXT_REPLY_HE}. אפשר לפנות לרכז.`,
        retrievedChunks: [chunk(0.5)],
      })
    ).toBe("model_declared_insufficient");
  });
});

describe("maxSimilarity", () => {
  it("returns the best match", () => {
    expect(maxSimilarity([chunk(0.4), chunk(0.81), chunk(0.6)])).toBe(0.81);
  });

  it("distinguishes nothing-retrieved from a poor match", () => {
    // NULL and 0 mean different things downstream: no retrieval at all versus a
    // retrieval that came back bad. Both are gaps; they are not the same gap.
    expect(maxSimilarity([])).toBeNull();
    expect(maxSimilarity([chunk(0)])).toBe(0);
  });
});
