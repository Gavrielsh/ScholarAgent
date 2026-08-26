import { NextRequest, NextResponse } from "next/server";
import { timingSafeStringEqual } from "@/lib/security/auth/timingSafe";
import { hardDeleteKnowledgeChunksByDocumentId } from "@/lib/core/db";
import { logError } from "@/lib/core/logger";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorized(request: NextRequest, secret: string): boolean {
  const provided = request.headers.get("x-webhook-secret") ?? "";
  return timingSafeStringEqual(provided, secret);
}

// Hard-delete chunks when upstream CMS / Drive signals source removal or full redaction.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.DOCUMENT_WEBHOOK_SECRET?.trim();
  if (!secret || !authorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { documentId?: string };
  try {
    body = (await request.json()) as { documentId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const documentId = body.documentId?.trim() ?? "";
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json({ error: "documentId must be a UUID" }, { status: 400 });
  }

  try {
    const deleted = await hardDeleteKnowledgeChunksByDocumentId(documentId);
    return NextResponse.json({ ok: true, deletedRows: deleted });
  } catch (err) {
    logError("document_delete_webhook_failed", err, { documentId });
    return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
  }
}
