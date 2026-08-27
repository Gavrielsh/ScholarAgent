/**
 * sync_google_drive.ts — Google Drive → pgvector synchronisation for ScholarAgent
 *
 * Walks a single Drive folder and ingests every supported document into the
 * knowledge base through the normal ingestion pipeline, so Drive-sourced
 * documents are chunked, PII-redacted, embedded and RLS-classified exactly like
 * WhatsApp uploads and HTTP uploads.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/sync_google_drive.ts
 *   npx tsx --env-file=.env.local scripts/sync_google_drive.ts --dry-run
 *
 * Required environment:
 *   GOOGLE_APPLICATION_CREDENTIALS  Path to a service-account JSON key.
 *   GOOGLE_DRIVE_FOLDER_ID          Folder to synchronise (its direct children).
 *   DATABASE_URL                    Standard ScholarAgent connection string.
 *   GEMINI_API_KEY (or the configured embedding provider's key).
 *
 * Optional environment:
 *   DRIVE_SYNC_CLASSIFICATION_LEVEL  0-3, default 0 (admin-only). See below.
 *   DRIVE_SYNC_MAX_BYTES             Per-file size ceiling, default 20 MiB.
 *
 * The service account must be granted read access to the folder — sharing the
 * folder with the service account's email address is enough.
 *
 * Idempotency
 * -----------
 * Each ingested document records `drive_file_id` and `drive_modified_time` in
 * `ingested_documents.metadata`. On every run each Drive file is matched against
 * that registry:
 *
 *   - no row            → ingest, report "new"
 *   - same modifiedTime → skip without downloading, report "unchanged"
 *   - newer modifiedTime→ delete the old registry row (which cascades its chunks
 *                         away via trg_ingested_documents_cascade_chunks) and
 *                         re-ingest, report "updated"
 *
 * Deleting before re-ingesting is what keeps an edited document from ending up
 * in the corpus twice: `ingestDocument` mints a fresh document id per call, so
 * without the delete the previous version's chunks would stay retrievable
 * forever with no way to reach them.
 */

import { google, type drive_v3 } from "googleapis";

import { closePool, withRlsTransaction } from "@/lib/core/db";
import { ADMIN_PERMISSION_LEVEL, type PermissionLevel } from "@/lib/security/auth";
import {
  assertMimeMatchesContent,
  extractTextFromUpload,
  ingestDocument,
} from "@/lib/domain/ingestion/pipeline";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

/** Source tag written to `ingested_documents.source` and every chunk's metadata. */
const SOURCE = "google_drive";

/** Value written to `uploaded_by_user_id` (a TEXT column, not a users.id FK). */
const UPLOADED_BY_USER_ID = "system-drive-sync";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Drive MIME type → the MIME type the ingestion pipeline's extractor table keys
 * on. Anything absent here is skipped and reported, rather than downloaded and
 * then rejected by `extractTextFromUpload`.
 *
 * Native Google formats (`application/vnd.google-apps.*`) are deliberately not
 * listed: they carry no byte stream and would need `files.export` rather than
 * `files.get`, which is a different code path and a different fidelity trade-off.
 */
const SUPPORTED_MIME_TYPES: Record<string, string> = {
  "application/pdf": "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain": "text/plain",
  "text/markdown": "text/markdown",
  "text/csv": "text/csv",
};

/** Drive reports `.md` files inconsistently; fall back to the extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface SyncConfig {
  folderId: string;
  classificationLevel: PermissionLevel;
  maxBytes: number;
  dryRun: boolean;
}

function parseClassificationLevel(raw: string | undefined): PermissionLevel {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (parsed !== 0 && parsed !== 1 && parsed !== 2 && parsed !== 3) {
    throw new Error(
      `DRIVE_SYNC_CLASSIFICATION_LEVEL must be 0, 1, 2 or 3 — got "${raw}".`
    );
  }
  return parsed;
}

function parseMaxBytes(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function readConfig(): SyncConfig {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  if (!folderId) {
    throw new Error(
      "Missing GOOGLE_DRIVE_FOLDER_ID. Set it to the id in the folder's URL " +
        "(https://drive.google.com/drive/folders/<THIS PART>)."
    );
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    throw new Error(
      "Missing GOOGLE_APPLICATION_CREDENTIALS. Point it at a service-account " +
        "JSON key that has read access to the folder."
    );
  }

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("Missing DATABASE_URL — the ingestion pipeline cannot write.");
  }

  return {
    folderId,
    classificationLevel: parseClassificationLevel(process.env.DRIVE_SYNC_CLASSIFICATION_LEVEL),
    maxBytes: parseMaxBytes(process.env.DRIVE_SYNC_MAX_BYTES),
    dryRun: process.argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Drive access
// ---------------------------------------------------------------------------

async function createDriveClient(): Promise<drive_v3.Drive> {
  // GoogleAuth reads GOOGLE_APPLICATION_CREDENTIALS itself; passing the path
  // explicitly would break the other ADC sources (workload identity, gcloud
  // application-default login) that the same code should keep supporting.
  const auth = new google.auth.GoogleAuth({ scopes: DRIVE_SCOPES });
  const authClient = await auth.getClient();
  return google.drive({ version: "v3", auth: authClient as never });
}

/** A Drive file, reduced to the fields this script actually needs. */
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  sizeBytes: number | null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Resolves the MIME type the pipeline should extract with.
 *
 * Drive's reported type wins when it is one we support; otherwise the filename
 * extension is consulted, because Drive commonly reports `.md` as `text/plain`
 * or `application/octet-stream` depending on how the file was uploaded.
 */
function resolveMimeType(file: DriveFile): string | null {
  const declared = file.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const byExtension = MIME_BY_EXTENSION[extensionOf(file.name)];

  // A markdown file uploaded as text/plain should still be tagged text/markdown.
  if (byExtension === "text/markdown") return byExtension;
  if (SUPPORTED_MIME_TYPES[declared]) return SUPPORTED_MIME_TYPES[declared];
  return byExtension ?? null;
}

/** Every non-trashed direct child of the folder, following pagination to the end. */
async function listFolderFiles(
  drive: drive_v3.Drive,
  folderId: string
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
      pageSize: 100,
      pageToken,
      // Required for folders that live in a shared drive; harmless otherwise.
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of response.data.files ?? []) {
      // id/name/mimeType/modifiedTime are all optional in the generated types.
      // A file missing any of them cannot be fetched or compared, so skip it
      // rather than casting the absence away.
      if (!file.id || !file.name || !file.mimeType || !file.modifiedTime) {
        console.warn(`  ⚠ skipping a Drive entry with incomplete metadata (id=${file.id ?? "?"})`);
        continue;
      }
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        sizeBytes: file.size === null || file.size === undefined ? null : Number(file.size),
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

async function downloadFile(drive: drive_v3.Drive, fileId: string): Promise<ArrayBuffer> {
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  // With responseType "arraybuffer" the generated typings still describe
  // `data` as unknown, so narrow it here rather than at every call site.
  const data = response.data as ArrayBuffer | Buffer;
  if (Buffer.isBuffer(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Registry lookups (idempotency)
// ---------------------------------------------------------------------------

interface RegisteredDocument {
  documentId: string;
  driveModifiedTime: string | null;
}

/**
 * Finds the most recent registry row for a Drive file id.
 *
 * Runs at admin privilege deliberately: `ingested_documents` is FORCE ROW LEVEL
 * SECURITY and its SELECT policy compares `classification_level` against
 * `app.user_permission_level`. With that setting unset the comparison is NULL,
 * no row is visible, and this function would report every file as new — turning
 * every run into a full re-ingest of the whole folder.
 */
async function findRegisteredDocument(driveFileId: string): Promise<RegisteredDocument | null> {
  return withRlsTransaction(ADMIN_PERMISSION_LEVEL, async (client) => {
    const result = await client.query<{ id: string; drive_modified_time: string | null }>(
      `SELECT id, metadata->>'drive_modified_time' AS drive_modified_time
         FROM ingested_documents
        WHERE metadata->>'drive_file_id' = $1
        ORDER BY created_at DESC
        LIMIT 1;`,
      [driveFileId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { documentId: row.id, driveModifiedTime: row.drive_modified_time };
  });
}

/**
 * Removes a superseded document.
 *
 * Only the registry row is deleted: `trg_ingested_documents_cascade_chunks`
 * retracts its knowledge_base chunks on the way out, so doing both here would
 * be redundant and would race the trigger.
 */
async function deleteRegisteredDocument(documentId: string): Promise<void> {
  await withRlsTransaction(ADMIN_PERMISSION_LEVEL, async (client) => {
    await client.query(`DELETE FROM ingested_documents WHERE id = $1;`, [documentId]);
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

type Outcome = "new" | "updated" | "unchanged" | "skipped" | "failed";

interface SyncTotals {
  new: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  chunks: number;
}

async function syncFile(
  drive: drive_v3.Drive,
  file: DriveFile,
  config: SyncConfig,
  totals: SyncTotals
): Promise<Outcome> {
  const mimeType = resolveMimeType(file);
  if (!mimeType) {
    console.log(`  ⏭  ${file.name} — unsupported type (${file.mimeType})`);
    totals.skipped += 1;
    return "skipped";
  }

  if (config.maxBytes > 0 && file.sizeBytes !== null && file.sizeBytes > config.maxBytes) {
    console.log(
      `  ⏭  ${file.name} — ${file.sizeBytes} bytes exceeds DRIVE_SYNC_MAX_BYTES (${config.maxBytes})`
    );
    totals.skipped += 1;
    return "skipped";
  }

  const existing = await findRegisteredDocument(file.id);

  // The comparison is on Drive's own modifiedTime string, stored verbatim on the
  // previous ingestion. Comparing parsed dates instead would make an unchanged
  // file look changed whenever Drive alters its timestamp formatting.
  if (existing && existing.driveModifiedTime === file.modifiedTime) {
    console.log(`  ✓  ${file.name} — unchanged (${file.modifiedTime})`);
    totals.unchanged += 1;
    return "unchanged";
  }

  const isUpdate = existing !== null;
  const label = isUpdate ? "updated in Drive" : "new";
  console.log(`  →  ${file.name} — ${label} (${file.modifiedTime})`);

  if (config.dryRun) {
    console.log(`     [dry-run] would ${isUpdate ? "re-ingest" : "ingest"} this file`);
    totals[isUpdate ? "updated" : "new"] += 1;
    return isUpdate ? "updated" : "new";
  }

  const bytes = await downloadFile(drive, file.id);

  // Same guard the HTTP upload route applies: a file whose declared type does
  // not match its magic bytes is rejected before it reaches a parser.
  assertMimeMatchesContent(new Uint8Array(bytes), mimeType);

  const text = await extractTextFromUpload(bytes, mimeType);
  if (!text.trim()) {
    console.log(`     ⚠ no extractable text — skipping (scanned image or empty document?)`);
    totals.skipped += 1;
    return "skipped";
  }

  // Delete only after the new content is in hand: if extraction fails above, the
  // previous version stays queryable rather than the corpus losing a document.
  if (existing) {
    await deleteRegisteredDocument(existing.documentId);
  }

  const result = await ingestDocument({
    filename: file.name,
    mimeType,
    text,
    classificationLevel: config.classificationLevel,
    uploadedByUserId: UPLOADED_BY_USER_ID,
    // Admin write level: required for the corpus INSERT policy, and independent
    // of the classification the chunks are stored at.
    uploadedByPermissionLevel: ADMIN_PERMISSION_LEVEL,
    source: SOURCE,
    extraMetadata: {
      drive_file_id: file.id,
      drive_modified_time: file.modifiedTime,
      drive_folder_id: config.folderId,
      drive_mime_type: file.mimeType,
      original_size_bytes: file.sizeBytes,
      synced_at: new Date().toISOString(),
    },
  });

  console.log(
    `     ✅ ${result.chunkCount} chunk(s) → document ${result.documentId}` +
      (isUpdate ? " (previous version removed)" : "")
  );

  totals.chunks += result.chunkCount;
  totals[isUpdate ? "updated" : "new"] += 1;
  return isUpdate ? "updated" : "new";
}

async function main(): Promise<void> {
  const config = readConfig();

  console.log("Google Drive → ScholarAgent sync");
  console.log(`  folder:         ${config.folderId}`);
  console.log(`  classification: L${config.classificationLevel}`);
  console.log(`  max file size:  ${config.maxBytes} bytes`);
  if (config.dryRun) console.log("  mode:           DRY RUN (nothing is written)");
  console.log("");

  const drive = await createDriveClient();
  const files = await listFolderFiles(drive, config.folderId);

  if (files.length === 0) {
    console.log("No files found in the folder. Is it shared with the service account?");
    return;
  }

  console.log(`Found ${files.length} file(s).\n`);

  const totals: SyncTotals = {
    new: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    chunks: 0,
  };

  // Sequential on purpose: each ingestion holds a document, its chunks and every
  // 768-float vector in memory, and they all contend for the same embedding
  // provider quota. Parallelising here buys throttling, not throughput.
  for (const file of files) {
    try {
      await syncFile(drive, file, config, totals);
    } catch (err) {
      // One unreadable file must not abandon the rest of the folder.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${file.name} — ${message}`);
      totals.failed += 1;
    }
  }

  console.log("\n─────────────────────────────────────────");
  console.log(`  new:       ${totals.new}`);
  console.log(`  updated:   ${totals.updated}`);
  console.log(`  unchanged: ${totals.unchanged}`);
  console.log(`  skipped:   ${totals.skipped}`);
  console.log(`  failed:    ${totals.failed}`);
  console.log(`  chunks:    ${totals.chunks}`);
  console.log("─────────────────────────────────────────");

  if (totals.failed > 0) {
    // Non-zero exit so a cron or CI wrapper notices a partial sync.
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("\nSync failed:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Without this the pg pool keeps the event loop alive and the script hangs
    // after printing its summary.
    await closePool().catch(() => {});
  });
