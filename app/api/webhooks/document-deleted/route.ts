import { NextRequest, NextResponse } from "next/server";

import { hardDeleteKnowledgeChunksByDocumentId } from "@/lib/db/pgvector";

// Hard-delete chunks when upstream CMS / Drive signals source removal or full redaction.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.DOCUMENT_WEBHOOK_SECRET;
  if (!secret || request.headers.get("x-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { documentId?: string };
  try {
    body = (await request.json()) as { documentId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const documentId = body.documentId?.trim();
  if (!documentId) {
    return NextResponse.json({ error: "documentId required" }, { status: 400 });
  }

  try {
    const deleted = await hardDeleteKnowledgeChunksByDocumentId(documentId);
    return NextResponse.json({ ok: true, deletedRows: deleted });
  } catch (err) {
    console.error("Document delete webhook failed:", err);
    return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
  }
}
