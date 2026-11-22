import {
  insertDocumentWithChunks,
  resolveParentChunks,
  type DocumentChunkRecord,
  type SimilarDocument,
} from "@/lib/core/db";
import type { AccessLevel } from "@/lib/core/db/accessLevel";

/**
 * Parent/child ("small-to-big") retrieval — migration 004.
 *
 * The security-relevant claim under test is that widening a matched child to
 * its parent never widens what the caller is allowed to see: the parent SELECT
 * runs on the client it is handed, which on every user-facing path is the one
 * already inside withRlsTransaction. These tests pin the widening, dedup and
 * fail-safe rules; they use a fake client and need no database.
 */

const L2 = 2 as AccessLevel;

function childRow(
  id: string,
  parentId: string | null,
  overrides: Partial<SimilarDepthDoc> = {}
): SimilarDocument {
  return {
    id,
    text: `child body ${id}`,
    metadata: { chunk_index: 0 },
    classificationLevel: L2,
    similarity: 0.5,
    parentId,
    ...overrides,
  };
}

type SimilarDepthDoc = SimilarDocument;

/** Stands in for a PoolClient, recording the parent-fetch it was asked for. */
function fakeClient(parentRows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: parentRows };
    },
  };
  return { client: client as unknown as Parameters<typeof resolveParentChunks>[0], calls };
}

describe("resolveParentChunks", () => {
  it("spends no round trip on a flat corpus", async () => {
    // Every row written before migration 004 has parent_id = NULL. Retrieval
    // for the existing graded corpus must not pay for a parent lookup.
    const { client, calls } = fakeClient([]);
    const rows = [childRow("a", null), childRow("b", null)];

    const out = await resolveParentChunks(client, rows);

    expect(calls).toHaveLength(0);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]!.text).toBe("child body a");
  });

  it("widens a child to its parent's text and keeps the child id for tracing", async () => {
    const { client } = fakeClient([
      {
        id: "p1",
        content: "the full parent passage",
        metadata: { is_parent: true },
        classification_level: L2,
        parent_id: null,
        similarity: 0,
      },
    ]);

    const out = await resolveParentChunks(client, [childRow("c1", "p1")]);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("p1");
    expect(out[0]!.text).toBe("the full parent passage");
    expect(out[0]!.matchedChildId).toBe("c1");
    // Already resolved — nothing downstream should try to widen it again.
    expect(out[0]!.parentId).toBeNull();
  });

  it("deduplicates several children of one parent, keeping the best rank", async () => {
    // Three children of the same passage would otherwise spend the whole
    // context budget on one document.
    const { client } = fakeClient([
      {
        id: "p1",
        content: "parent passage",
        metadata: null,
        classification_level: L2,
        parent_id: null,
        similarity: 0,
      },
    ]);

    const rows = [
      childRow("c1", "p1", { rrfScore: 0.9 }),
      childRow("c2", "p1", { rrfScore: 0.4 }),
      childRow("c3", "p1", { rrfScore: 0.1 }),
    ];
    const out = await resolveParentChunks(client, rows);

    expect(out).toHaveLength(1);
    expect(out[0]!.rrfScore).toBe(0.9);
    expect(out[0]!.matchedChildId).toBe("c1");
  });

  it("preserves rank order across distinct parents", async () => {
    const { client } = fakeClient([
      { id: "p1", content: "P1", metadata: null, classification_level: L2, parent_id: null, similarity: 0 },
      { id: "p2", content: "P2", metadata: null, classification_level: L2, parent_id: null, similarity: 0 },
    ]);

    const out = await resolveParentChunks(client, [
      childRow("c2", "p2", { rrfScore: 0.8 }),
      childRow("c1", "p1", { rrfScore: 0.6 }),
    ]);

    expect(out.map((r) => r.id)).toEqual(["p2", "p1"]);
  });

  it("asks only for the distinct parent ids", async () => {
    const { client, calls } = fakeClient([
      { id: "p1", content: "P1", metadata: null, classification_level: L2, parent_id: null, similarity: 0 },
    ]);

    await resolveParentChunks(client, [childRow("c1", "p1"), childRow("c2", "p1")]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toEqual(["p1"]);
    // The parent fetch must itself be restricted to parent rows.
    expect(calls[0]!.sql).toContain("is_parent = true");
  });

  it("falls back to the child's own text when the parent row does not come back", async () => {
    // A parent the policy did not return (or a deleted row). Returning less
    // text is a degradation; returning another row's text would be a leak.
    const { client } = fakeClient([]);

    const out = await resolveParentChunks(client, [childRow("c1", "p-missing")]);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("c1");
    expect(out[0]!.text).toBe("child body c1");
    expect(out[0]!.matchedChildId).toBeUndefined();
  });

  it("takes classificationLevel from the parent row that was actually returned", async () => {
    // Never copied from the child: the value must describe the text being
    // returned, so a DLS check downstream is evaluated against the right tier.
    const { client } = fakeClient([
      {
        id: "p1",
        content: "parent passage",
        metadata: null,
        classification_level: 1 as AccessLevel,
        parent_id: null,
        similarity: 0,
      },
    ]);

    const out = await resolveParentChunks(client, [childRow("c1", "p1")]);

    expect(out[0]!.classificationLevel).toBe(1);
  });
});

/**
 * The FK added in migration 004 is self-referencing, so a parent has to be
 * inserted before any child that points at it. These are validated before the
 * transaction opens, so a bad shape never reaches the database — and the test
 * needs no connection.
 */
describe("insertDocumentWithChunks — parent/child shape validation", () => {
  // Real dimension: toVectorLiteral enforces 768 before the parent/child shape
  // is looked at, so a short vector would fail for the wrong reason.
  const vec = () => new Array(768).fill(0.01);

  const chunk = (over: Partial<DocumentChunkRecord> = {}): DocumentChunkRecord => ({
    text: "body",
    chunkIndex: 0,
    metadata: {},
    embedding: vec(),
    ...over,
  });

  const base = {
    documentId: "11111111-1111-1111-1111-111111111111",
    source: "upload_api",
    filename: "f.pdf",
    mimeType: "application/pdf",
    sizeBytes: null,
    sha256: null,
    externalMediaId: null,
    externalMessageId: null,
    uploadedByUserId: "u1",
    uploadedByPhone: null,
    classificationLevel: L2,
    writePermissionLevel: 1 as AccessLevel,
    documentMetadata: {},
  };

  it("rejects a child whose parent is inserted after it", async () => {
    await expect(
      insertDocumentWithChunks({
        ...base,
        chunks: [
          chunk({ parentIndex: 1 }),
          chunk({ embedding: null, isParent: true }),
        ],
      })
    ).rejects.toThrow(/inserted later|parents must precede/i);
  });

  it("rejects a chunk that lists itself as its own parent", async () => {
    await expect(
      insertDocumentWithChunks({ ...base, chunks: [chunk({ parentIndex: 0 })] })
    ).rejects.toThrow(/itself as its own parent/i);
  });

  it("rejects an out-of-range parentIndex", async () => {
    await expect(
      insertDocumentWithChunks({ ...base, chunks: [chunk({ parentIndex: 7 })] })
    ).rejects.toThrow(/out-of-range parentIndex/i);
  });

  it("rejects a parentIndex pointing at a non-parent row", async () => {
    await expect(
      insertDocumentWithChunks({
        ...base,
        chunks: [chunk(), chunk({ parentIndex: 0 })],
      })
    ).rejects.toThrow(/not a parent row/i);
  });
});
