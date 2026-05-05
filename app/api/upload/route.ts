import { NextRequest, NextResponse } from "next/server";

import { extractUserContext, UnauthenticatedError } from "@/lib/auth/extractUser";
import { assertMinimumLevel } from "@/lib/auth/rbac";
import type { PermissionLevel } from "@/lib/auth/types";
import { extractTextFromUpload, ingestDocument } from "@/lib/ingestion/uploader";

// 10 MB hard cap per upload. TODO: tune via env once usage patterns are clear.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// Only Manager (L1) and Admin (L0) may upload knowledge into the corpus.
const MIN_UPLOAD_LEVEL: PermissionLevel = 1;

const VALID_CLASSIFICATION_LEVELS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  // TODO: Translate/Adapt this response to Hebrew.
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authentication & authorisation ────────────────────────────────────
  let user;
  try {
    user = extractUserContext(request);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return jsonError(401, err.message);
    }
    return jsonError(500, "Failed to read auth context.");
  }

  try {
    assertMinimumLevel(user, MIN_UPLOAD_LEVEL);
  } catch {
    return jsonError(403, "Only Managers and Admins may upload documents.");
  }

  // ── 2. Parse multipart form ──────────────────────────────────────────────
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Request body is not valid multipart/form-data.");
  }

  const file = form.get("file");
  const classificationRaw = form.get("classificationLevel");

  if (!(file instanceof File)) {
    return jsonError(400, "Missing required form field: file.");
  }

  if (classificationRaw === null) {
    return jsonError(400, "Missing required form field: classificationLevel.");
  }

  const classificationLevel = Number.parseInt(String(classificationRaw), 10);
  if (
    !Number.isInteger(classificationLevel) ||
    !VALID_CLASSIFICATION_LEVELS.has(classificationLevel)
  ) {
    return jsonError(
      400,
      `Invalid classificationLevel "${classificationRaw}". Must be 0–4.`
    );
  }

  // A user cannot classify content at a level higher than their own privilege —
  // otherwise an L1 Manager could publish L0 (admin-only) data.
  if (classificationLevel < user.permissionLevel) {
    return jsonError(
      403,
      `You cannot classify a document below your own permission level (${user.permissionLevel}).`
    );
  }

  // ── 3. File validation ───────────────────────────────────────────────────
  if (file.size === 0) {
    return jsonError(400, "Uploaded file is empty.");
  }

  if (file.size > MAX_FILE_BYTES) {
    return jsonError(413, `File exceeds ${MAX_FILE_BYTES} bytes maximum.`);
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return jsonError(415, `Unsupported MIME type: ${file.type || "<unknown>"}.`);
  }

  // ── 4. Extract text ──────────────────────────────────────────────────────
  let text: string;
  try {
    const bytes = await file.arrayBuffer();
    text = await extractTextFromUpload(bytes, file.type);
  } catch (err) {
    return jsonError(
      422,
      err instanceof Error ? err.message : "Failed to extract text from upload."
    );
  }

  if (!text.trim()) {
    return jsonError(422, "No extractable text content in uploaded file.");
  }

  // ── 5. Ingest (chunk → embed → insert) ───────────────────────────────────
  try {
    const result = await ingestDocument({
      filename: file.name,
      mimeType: file.type,
      text,
      classificationLevel: classificationLevel as PermissionLevel,
      uploadedByUserId: user.userId,
      extraMetadata: {
        organization_id: user.organizationId ?? null,
        original_size_bytes: file.size,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        // TODO: Translate/Adapt this response to Hebrew.
        message: "Document ingested successfully.",
        ...result,
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown ingestion error.";
    // TODO: Distinguish DB connection errors from embedding errors with
    //       structured error types so retries can be targeted intelligently.
    return jsonError(502, `Ingestion failed: ${message}`);
  }
}

// Reject other verbs explicitly so misconfigured clients get a clear signal.
export async function GET(): Promise<NextResponse> {
  return jsonError(405, "Use POST multipart/form-data to upload a document.");
}
