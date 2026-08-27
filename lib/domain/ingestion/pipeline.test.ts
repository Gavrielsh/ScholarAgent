import { buildChunkMetadata, resolveClassificationLevel } from "@/lib/domain/ingestion/pipeline";

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
