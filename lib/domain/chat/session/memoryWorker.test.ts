import {
  MEMORY_SUMMARIZATION_QUEUE_NAME,
  memorySummarizationJobId,
  normalizeSummary,
} from "@/lib/domain/chat/session/memoryWorker";

/**
 * Rolling memory worker — migration 005.
 *
 * These cover the pure, database-free parts: the job-id derivation (which is
 * what makes a burst of messages coalesce into one summarisation) and the
 * summary normalisation (which is what stops a mock or a refusal from wiping a
 * sender's stored memory). The RLS scoping itself is exercised by the
 * security-eval-gate CI job against a real Postgres, not here.
 */

describe("memorySummarizationJobId", () => {
  it("is derived from the sender, so repeat messages coalesce into one job", () => {
    // Deliberately NOT keyed on the message id: a sender who sends five
    // messages while a job is queued should get one summarisation, not five.
    expect(memorySummarizationJobId("972501234567")).toBe("mem_972501234567");
    expect(memorySummarizationJobId("972501234567")).toBe(
      memorySummarizationJobId("972501234567")
    );
  });

  it("strips colons, which BullMQ rejects in a custom job id", () => {
    expect(memorySummarizationJobId("wa:972501234567")).toBe("mem_wa_972501234567");
    expect(memorySummarizationJobId("a:b:c")).not.toContain(":");
  });

  it("uses its own queue, separate from chat and ingestion", () => {
    // Shared process, separate queues: a summarisation job must never occupy a
    // concurrency slot that a conversation needs.
    expect(MEMORY_SUMMARIZATION_QUEUE_NAME).toBe("memory-summarization");
  });
});

describe("normalizeSummary", () => {
  it("keeps a normal summary, trimmed", () => {
    expect(normalizeSummary("  מנטור לכיתה ו, מתמודד עם קונפליקטים בקבוצה.  ")).toBe(
      "מנטור לכיתה ו, מתמודד עם קונפליקטים בקבוצה."
    );
  });

  it("returns null for anything blank rather than storing an empty memory", () => {
    // Overwriting a good summary with "" would silently erase the sender's
    // memory — a mock provider or a model refusal must not be able to do that.
    expect(normalizeSummary("")).toBeNull();
    expect(normalizeSummary("   \n\t  ")).toBeNull();
    expect(normalizeSummary(undefined as unknown as string)).toBeNull();
  });

  it("bounds an over-long summary instead of letting the prompt grow unbounded", () => {
    const long = "א".repeat(5_000);
    const out = normalizeSummary(long);

    expect(out).not.toBeNull();
    // Default ceiling is 1,200 chars (MEMORY_SUMMARY_MAX_CHARS).
    expect(out!.length).toBeLessThanOrEqual(1_200);
    expect(out!.length).toBeGreaterThan(0);
  });

  it("is idempotent — renormalising a stored summary does not shrink it further", () => {
    const once = normalizeSummary("א".repeat(5_000))!;
    expect(normalizeSummary(once)).toBe(once);
  });
});
