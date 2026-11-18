import {
  chunkSourcePath,
  GOLDEN_BY_ID,
  GOLDEN_DATASET,
  GOLDEN_QUERIES,
  tierToPermissionLevel,
} from "./golden_dataset";
import { LEAKAGE_SPECS } from "./leakage_specs";

const TIER_LEVEL = { L0: 0, L1: 1, L2: 2 } as const;

describe("golden dataset — composition", () => {
  it("holds 30 queries with the documented split", () => {
    expect(GOLDEN_QUERIES).toHaveLength(30);
    const byCategory = GOLDEN_QUERIES.reduce<Record<string, number>>((a, q) => {
      a[q.category] = (a[q.category] ?? 0) + 1;
      return a;
    }, {});
    expect(byCategory).toEqual({
      standard_ir: 15,
      canary_extraction: 6,
      semantic_collision: 6,
      privilege_escalation: 3,
    });
  });

  it("uses the STD-001..015 / ADV-001..015 id sequence with no gaps", () => {
    const expected = [
      ...Array.from({ length: 15 }, (_, i) => `STD-${String(i + 1).padStart(3, "0")}`),
      ...Array.from({ length: 15 }, (_, i) => `ADV-${String(i + 1).padStart(3, "0")}`),
    ];
    expect(GOLDEN_QUERIES.map((q) => q.id)).toEqual(expected);
  });
});

describe("golden dataset — tier invariants", () => {
  it("never expects a document above the asker's clearance", () => {
    // Expecting an above-tier document would make the benchmark demand the very
    // leak it is meant to detect.
    for (const q of GOLDEN_QUERIES) {
      const asker = TIER_LEVEL[q.user_tier];
      for (const file of q.expected_doc_filenames) {
        const docTier = TIER_LEVEL[file.slice(0, 2) as keyof typeof TIER_LEVEL];
        expect(docTier).toBeGreaterThanOrEqual(asker);
      }
    }
  });

  it("only forbids documents strictly above the asker's clearance", () => {
    // Forbidding a document at or below the asker's tier would fail the system
    // for correct behaviour.
    for (const q of GOLDEN_QUERIES) {
      const asker = TIER_LEVEL[q.user_tier];
      for (const file of q.forbidden_doc_filenames) {
        const docTier = TIER_LEVEL[file.slice(0, 2) as keyof typeof TIER_LEVEL];
        expect(docTier).toBeLessThan(asker);
      }
    }
  });

  it("gives every out-of-tier attack at least one forbidden term", () => {
    // A guard with no terms is a check that cannot fail.
    for (const q of GOLDEN_QUERIES) {
      if (q.category === "standard_ir") continue;
      expect(q.forbidden_terms.length).toBeGreaterThan(0);
    }
  });

  it("expects no documents for pure extraction and escalation attacks", () => {
    // Retrieving nothing is the correct outcome, not a retrieval failure.
    for (const q of GOLDEN_QUERIES) {
      if (q.category === "canary_extraction" || q.category === "privilege_escalation") {
        expect(q.expected_doc_filenames).toEqual([]);
      }
    }
  });

  it("gives semantic-collision attacks something they SHOULD retrieve", () => {
    // These are not refusals: the own-tier policy must still be answered, which
    // is what separates correct scoping from blanket refusal.
    for (const q of GOLDEN_QUERIES) {
      if (q.category === "semantic_collision") {
        expect(q.expected_doc_filenames.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("leakage specs derived from the dataset", () => {
  it("covers every query id exactly, with no stale or missing keys", () => {
    // The previous hand-keyed map silently mismatched after the dataset was
    // rewritten; deriving them makes that impossible, and this asserts it.
    expect(Object.keys(LEAKAGE_SPECS).sort()).toEqual(GOLDEN_QUERIES.map((q) => q.id).sort());
  });

  it("carries each query's own forbidden terms as its canaries", () => {
    for (const q of GOLDEN_QUERIES) {
      expect(LEAKAGE_SPECS[q.id].canaries).toEqual(q.forbidden_terms);
    }
  });

  it("maps categories to the expected attack families", () => {
    expect(LEAKAGE_SPECS["ADV-001"].family).toBe("authorization_escalation");
    expect(LEAKAGE_SPECS["ADV-007"].family).toBe("authorization_escalation");
    expect(LEAKAGE_SPECS["ADV-013"].family).toBe("prompt_injection");
    expect(LEAKAGE_SPECS["STD-001"].family).toBe("benign_control");
  });

  it("names the asking tier in every rubric", () => {
    for (const q of GOLDEN_QUERIES) {
      expect(LEAKAGE_SPECS[q.id].prohibitedDisclosure).toContain(q.user_tier);
    }
  });
});

describe("EvalRecord compatibility view", () => {
  it("maps tier labels to numeric permission levels", () => {
    expect(tierToPermissionLevel("L0")).toBe(0);
    expect(tierToPermissionLevel("L1")).toBe(1);
    expect(tierToPermissionLevel("L2")).toBe(2);
  });

  it("collapses the four categories into the runner's two", () => {
    const std = GOLDEN_DATASET.find((r) => r.id === "STD-001");
    const adv = GOLDEN_DATASET.find((r) => r.id === "ADV-001");
    expect(std?.category).toBe("standard");
    expect(adv?.category).toBe("adversarial");
  });

  it("exposes question, userRole and the full golden record", () => {
    const r = GOLDEN_DATASET.find((rec) => rec.id === "STD-006");
    expect(r?.userRole).toBe(1);
    expect(r?.question).toBe(GOLDEN_BY_ID.get("STD-006")?.query);
    expect(r?.golden.user_tier).toBe("L1");
  });

  it("builds a non-empty groundTruthAnswer for every record", () => {
    for (const r of GOLDEN_DATASET) {
      expect(r.groundTruthAnswer.length).toBeGreaterThan(0);
    }
  });
});

describe("chunkSourcePath", () => {
  it("normalises Windows separators, which path.relative produces there", () => {
    // Without this a dataset written with forward slashes matches nothing on
    // the machine the benchmark actually runs on.
    expect(chunkSourcePath({ source_path: "L0\\01_major_donors_audit.md" })).toBe(
      "L0/01_major_donors_audit.md"
    );
  });

  it("passes POSIX paths through unchanged", () => {
    expect(chunkSourcePath({ source_path: "L2/03_volunteer_travel_reimbursement.md" })).toBe(
      "L2/03_volunteer_travel_reimbursement.md"
    );
  });

  it("returns null for chunks with no source path, such as seeded canaries", () => {
    expect(chunkSourcePath(null)).toBeNull();
    expect(chunkSourcePath({})).toBeNull();
    expect(chunkSourcePath({ source_path: 42 })).toBeNull();
  });
});
