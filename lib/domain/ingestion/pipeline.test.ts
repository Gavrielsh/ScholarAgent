import {
  buildChunkMetadata,
  buildContextualHeader,
  buildParentChildRecords,
  chunkTextParentChild,
  detectSectionHeading,
  DocumentLimitError,
  ingestDocument,
  planParentChildChunks,
  resolveClassificationLevel,
  withContextualHeader,
} from "@/lib/domain/ingestion/pipeline";

// The persistence layer serialises this payload verbatim, and the delete path
// (`metadata->>'document_id'`) plus the admin reports (`uploaded_by`) filter on
// these exact keys. Every ingestion path builds its metadata here, so this test
// pins the shape they all share.
describe("buildChunkMetadata", () => {
  const base = {
    documentId: "doc-1",
    filename: "handbook.pdf",
    mimeType: "application/pdf",
    uploadedByUserId: "user-7",
    classificationLevel: 2 as const,
    chunk: { index: 3, charStart: 100, charEnd: 250 },
  };

  it("emits the corpus-wide key contract", () => {
    expect(buildChunkMetadata(base)).toEqual({
      document_id: "doc-1",
      filename: "handbook.pdf",
      mime_type: "application/pdf",
      uploaded_by: "user-7",
      required_role: 2,
      chunk_index: 3,
      char_start: 100,
      char_end: 250,
    });
  });

  it("merges channel extras underneath the contract keys", () => {
    const meta = buildChunkMetadata({
      ...base,
      extra: { source: "whatsapp", wa_media_id: "media-9" },
    });
    expect(meta.source).toBe("whatsapp");
    expect(meta.wa_media_id).toBe("media-9");
    expect(meta.document_id).toBe("doc-1");
  });

  it("never lets an extra override a contract key", () => {
    const meta = buildChunkMetadata({
      ...base,
      extra: { document_id: "spoofed", uploaded_by: "spoofed" },
    });
    expect(meta.document_id).toBe("doc-1");
    expect(meta.uploaded_by).toBe("user-7");
  });
});

describe("resolveClassificationLevel", () => {
  it("defaults to the manager tier when the caption carries no directive", () => {
    expect(resolveClassificationLevel(null, 0)).toBe(1);
    expect(resolveClassificationLevel("סיכום פעילות נובמבר", 0)).toBe(1);
  });

  it("honours an explicit directive in any of the accepted spellings", () => {
    expect(resolveClassificationLevel("#L3 חומרי הדרכה", 0)).toBe(3);
    expect(resolveClassificationLevel("level: 2", 0)).toBe(2);
    expect(resolveClassificationLevel("רמה 0", 0)).toBe(0);
  });

  it("never lets a sender classify above their own privilege", () => {
    // An L1 Manager asking for the admin-only tier is clamped back to L1.
    expect(resolveClassificationLevel("#L0", 1)).toBe(1);
    expect(resolveClassificationLevel(null, 1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Contextual chunk enrichment + parent/child chunking (migration 004)
// ---------------------------------------------------------------------------

describe("detectSectionHeading", () => {
  it("recognises markdown headings and returns the text without the hashes", () => {
    expect(detectSectionHeading("## נהלי החזר הוצאות")).toBe("נהלי החזר הוצאות");
    expect(detectSectionHeading("# Travel Policy")).toBe("Travel Policy");
  });

  it("recognises a numbered division label", () => {
    expect(detectSectionHeading("3.2 תקרת החזר יומית")).toBe("3.2 תקרת החזר יומית");
    expect(detectSectionHeading("4) Travel budget")).toBe("4) Travel budget");
  });

  it("recognises the Hebrew structural words", () => {
    expect(detectSectionHeading("סעיף 5 — נהלי דיווח")).toBe("סעיף 5 — נהלי דיווח");
    expect(detectSectionHeading("נספח א הגדרות")).toBe("נספח א הגדרות");
  });

  it("recognises a bold-only line", () => {
    expect(detectSectionHeading("**הגדרות**")).toBe("הגדרות");
  });

  it("does not mistake an ordinary sentence for a heading", () => {
    // A false positive mislabels the section in the header, which is noise in
    // the embedding — so the detector has to stay conservative.
    expect(detectSectionHeading("המתנדב יגיש את הבקשה בתוך שבועיים.")).toBeNull();
    expect(detectSectionHeading("3.2 תקרת החזר יומית היא 50 ש\"ח.")).toBeNull();
    expect(detectSectionHeading("")).toBeNull();
  });

  it("rejects a line too long to be a heading", () => {
    expect(detectSectionHeading("1. " + "א".repeat(200))).toBeNull();
  });
});

describe("buildContextualHeader", () => {
  it("carries the filename and the classification tier", () => {
    expect(buildContextualHeader({ filename: "handbook.pdf", classificationLevel: 2 })).toBe(
      "[מסמך: handbook.pdf | רמת סיווג: L2]\n"
    );
  });

  it("adds the section only when there is one", () => {
    expect(
      buildContextualHeader({
        filename: "handbook.pdf",
        classificationLevel: 1,
        section: "נהלי החזר",
      })
    ).toBe("[מסמך: handbook.pdf | רמת סיווג: L1 | סעיף: נהלי החזר]\n");

    // A blank section must not leave a dangling separator.
    expect(
      buildContextualHeader({ filename: "f.txt", classificationLevel: 3, section: "   " })
    ).toBe("[מסמך: f.txt | רמת סיווג: L3]\n");
  });
});

describe("chunkTextParentChild", () => {
  // Long enough to produce several parents at the ~1,400-char budget.
  const section = (heading: string, n: number) =>
    `${heading}\n\n` +
    Array.from({ length: n }, (_, i) => `זו פסקה מספר ${i} בתוך ${heading} עם תוכן ממשי להדגמה.`)
      .join(" ");

  const doc = [section("## נהלי החזר הוצאות", 40), section("## בטיחות בפעילות", 40)].join("\n\n");

  it("produces children that are smaller than their parents", () => {
    const { parents, children } = chunkTextParentChild(doc);

    expect(parents.length).toBeGreaterThan(1);
    expect(children.length).toBeGreaterThan(parents.length);

    const maxParent = Math.max(...parents.map((p) => p.text.length));
    const maxChild = Math.max(...children.map((c) => c.text.length));
    expect(maxChild).toBeLessThan(maxParent);
    expect(maxChild).toBeLessThanOrEqual(400);
  });

  it("links every child to a parent that exists", () => {
    const { parents, children } = chunkTextParentChild(doc);

    for (const child of children) {
      expect(child.parentIndex).toBeGreaterThanOrEqual(0);
      expect(child.parentIndex).toBeLessThan(parents.length);
    }
  });

  it("numbers children contiguously from zero across all parents", () => {
    // chunk_index is part of the corpus metadata contract and the backfill
    // path derives a deterministic id from it, so it must not restart per parent.
    const { children } = chunkTextParentChild(doc);
    expect(children.map((c) => c.index)).toEqual(children.map((_, i) => i));
  });

  it("gives a child its parent's section when its own slice has no heading", () => {
    const { children } = chunkTextParentChild(doc);
    const labelled = children.filter((c) => typeof c.section === "string" && c.section.length > 0);

    expect(labelled.length).toBeGreaterThan(0);
    expect(
      labelled.some((c) => c.section === "נהלי החזר הוצאות" || c.section === "בטיחות בפעילות")
    ).toBe(true);
  });

  it("still yields one parent and one child for a short document", () => {
    const { parents, children } = chunkTextParentChild("שורה אחת קצרה בלבד.");

    expect(parents).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(children[0]!.parentIndex).toBe(0);
  });

  it("returns nothing for empty input rather than an empty-text chunk", () => {
    expect(chunkTextParentChild("   ")).toEqual({ parents: [], children: [] });
  });
});

describe("ingestDocument — chunk ceiling", () => {
  it("rejects an oversized document before any embedding or database call", async () => {
    // ~8,000 distinct sentences is far past the default 400 searchable chunks.
    // The rejection must happen before the network: no GEMINI_API_KEY is set
    // here, so reaching the embedder would fail with a different error.
    const text = Array.from(
      { length: 8_000 },
      (_, i) => `זהו משפט מספר ${i} במסמך הבדיקה הארוך מאוד של הארגון.`
    ).join(" ");

    const attempt = ingestDocument({
      filename: "huge.txt",
      mimeType: "text/plain",
      text,
      classificationLevel: 2,
      uploadedByUserId: "user-1",
      uploadedByPermissionLevel: 1,
    });

    await expect(attempt).rejects.toBeInstanceOf(DocumentLimitError);
    await expect(attempt).rejects.toMatchObject({ limit: 400 });
  });
});

/**
 * Reconciliation rebuilds a document with `planParentChildChunks` +
 * `buildParentChildRecords`. These pin that the rebuilt rows have the same shape
 * live ingestion writes: 1400/400 parent/child sizes, a contextual header on
 * every stored body, parents first with no embedding, children linked by index.
 */
describe("reconciled parent/child chunking", () => {
  const section = (heading: string, n: number) =>
    `${heading}\n\n` +
    Array.from({ length: n }, (_, i) => `זו פסקה מספר ${i} בתוך ${heading} עם תוכן ממשי להדגמה.`)
      .join(" ");
  const text = [section("## נהלי החזר הוצאות", 40), section("## בטיחות בפעילות", 40)].join("\n\n");

  const plan = planParentChildChunks({ text, filename: "policy.pdf", classificationLevel: 2 });
  const documentId = "11111111-1111-1111-1111-111111111111";
  const recordsFor = (extra?: Record<string, unknown>) =>
    buildParentChildRecords({
      ...plan,
      vectors: plan.children.map(() => new Array(768).fill(0.1)),
      documentId,
      filename: "policy.pdf",
      mimeType: "application/pdf",
      uploadedByUserId: "u1",
      classificationLevel: 2,
      extra,
    });

  it("uses the live parent/child budgets, not the flat 1500/200 chunker", () => {
    expect(plan.parents.length).toBeGreaterThan(1);
    expect(plan.children.length).toBeGreaterThan(plan.parents.length);
    expect(Math.max(...plan.children.map((c) => c.text.length))).toBeLessThanOrEqual(400);
    expect(Math.max(...plan.parents.map((p) => p.text.length))).toBeLessThanOrEqual(1400);
  });

  it("prefixes every parent and child body with the contextual header", () => {
    expect(plan.parentTexts).toHaveLength(plan.parents.length);
    expect(plan.childTexts).toHaveLength(plan.children.length);

    for (const body of [...plan.parentTexts, ...plan.childTexts]) {
      expect(body.startsWith("[מסמך: policy.pdf | רמת סיווג: L2")).toBe(true);
    }
    expect(plan.childTexts.some((t) => t.includes("| סעיף: נהלי החזר הוצאות]"))).toBe(true);
  });

  it("builds the header exactly as live ingestion does", () => {
    const child = plan.children[0]!;
    const ctx = { filename: "policy.pdf", classificationLevel: 2 as const };
    expect(plan.childTexts[0]).toBe(withContextualHeader(child, ctx));
    expect(plan.childTexts[0]).toBe(
      buildContextualHeader({ ...ctx, section: child.section }) + child.text
    );
  });

  it("redacts PII before chunking", () => {
    const redacted = planParentChildChunks({
      text: "צרו קשר במייל someone@example.org לפרטים נוספים על ההחזר.",
      filename: "f.txt",
      classificationLevel: 1,
    });
    expect(redacted.childTexts.join("\n")).not.toContain("someone@example.org");
  });

  it("emits parents first (no embedding), then children linked by parentIndex", () => {
    const records = recordsFor({ reconciled: true });
    expect(records).toHaveLength(plan.parents.length + plan.children.length);

    for (const row of records.slice(0, plan.parents.length)) {
      expect(row.isParent).toBe(true);
      expect(row.embedding).toBeNull();
      expect(row.metadata.is_parent).toBe(true);
    }
    records.slice(plan.parents.length).forEach((row, i) => {
      expect(row.isParent).toBe(false);
      expect(row.embedding).not.toBeNull();
      expect(row.parentIndex).toBe(plan.children[i]!.parentIndex);
      // parents occupy [0, parents.length), so the index points at a parent row.
      expect(records[row.parentIndex!]!.isParent).toBe(true);
      expect(row.metadata.is_parent).toBeUndefined();
    });
  });

  it("carries the shared metadata contract and the reconcile extras on every row", () => {
    for (const row of recordsFor({ reconciled: true, reconciled_from: "file:policy.pdf" })) {
      expect(row.metadata).toMatchObject({
        document_id: documentId,
        filename: "policy.pdf",
        uploaded_by: "u1",
        required_role: 2,
        reconciled: true,
        reconciled_from: "file:policy.pdf",
      });
    }
  });

  it("refuses a vector set that is not aligned with the children", () => {
    expect(() =>
      buildParentChildRecords({
        ...plan,
        vectors: [],
        documentId,
        filename: "policy.pdf",
        mimeType: "application/pdf",
        uploadedByUserId: "u1",
        classificationLevel: 2,
      })
    ).toThrow(/Embedding count mismatch/);
  });

  it("yields no children for blank text, so the reconciler reports it unresolvable", () => {
    const empty = planParentChildChunks({ text: "  ", filename: "x", classificationLevel: 3 });
    expect(empty.children).toHaveLength(0);
    expect(empty.parents).toHaveLength(0);
  });
});
