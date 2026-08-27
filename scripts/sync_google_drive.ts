/**
 * sync_google_drive.ts — Google Drive → pgvector synchronisation for ScholarAgent
 *
 * Walks a Drive folder tree and ingests every supported document into the
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
 *   GOOGLE_DRIVE_FOLDER_ID          Root folder to synchronise, recursively.
 *   DATABASE_URL                    Standard ScholarAgent connection string.
 *   GEMINI_API_KEY (or the configured embedding provider's key).
 *
 * Optional environment:
 *   DRIVE_SYNC_CLASSIFICATION_LEVEL  0-3, default 0 (admin-only).
 *   DRIVE_SYNC_MAX_BYTES             Per-file size ceiling, default 20 MiB.
 *
 * The service account must be granted read access to the root folder — sharing
 * the folder with the service account's email address is enough, and the grant
 * is inherited by every subfolder.
 *
 * Traversal
 * ---------
 * The whole tree is walked breadth-first from the root folder. Each folder is
 * listed with `'<id>' in parents and trashed = false`, and any child that is
 * itself a folder is queued rather than skipped, so nesting depth is unbounded.
 *
 * A `visitedFolderIds` set guards the walk. Drive is a graph, not a tree: a
 * folder can legitimately appear under more than one parent, and shortcuts can
 * point back up the tree. Without the set such a layout would make the queue
 * cycle forever, re-ingesting the same documents on every lap.
 *
 * File types
 * ----------
 * Two kinds of file are ingested, and they need different Drive calls:
 *
 *   - Binary uploads (PDF, DOCX, TXT, MD, CSV) are fetched with
 *     `files.get({ alt: "media" })`.
 *   - Native Workspace files (Docs, Sheets, Slides) have no byte stream at all;
 *     `alt: "media"` returns 403 for them. They are converted on Google's side
 *     with `files.export`, which is a different method with a different
 *     parameter set — notably it accepts no `supportsAllDrives`.
 *
 * Native formats with no text-bearing export (Forms, Sites, Drawings, Jamboards,
 * Apps Script) are skipped and reported.
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

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

/**
 * Drive MIME type → the MIME type the ingestion pipeline's extractor table keys
 * on, for files that have a real byte stream.
 */
const BINARY_MIME_TYPES: Record<string, string> = {
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

/**
 * Native Workspace type → the format to ask `files.export` for.
 *
 * Every target here is one the pipeline's extractor table already handles, so an
 * exported document takes exactly the same path as an uploaded one. Sheets go to
 * CSV rather than plain text because CSV keeps the row/column structure that
 * makes a table's cells legible once chunked.
 */
const WORKSPACE_EXPORT_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
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

/** A Drive entry, reduced to the fields this script actually needs. */
interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  sizeBytes: number | null;
  /** Id of the folder this entry was listed under. */
  parentFolderId: string;
  /** Slash-joined folder names from the root, e.g. "Training/2026". */
  parentPath: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Lists one folder's direct children, following pagination to the end. */
async function listFolderChildren(
  drive: drive_v3.Drive,
  folderId: string,
  parentPath: string
): Promise<DriveEntry[]> {
  const entries: DriveEntry[] = [];
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
      // An entry missing any of them cannot be fetched or compared, so skip it
      // rather than casting the absence away.
      if (!file.id || !file.name || !file.mimeType || !file.modifiedTime) {
        console.warn(`  ⚠ skipping a Drive entry with incomplete metadata (id=${file.id ?? "?"})`);
        continue;
      }
      entries.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        // Native Workspace files report no size at all — that is expected, not
        // an error, and leaves the size ceiling inapplicable to them.
        sizeBytes: file.size === null || file.size === undefined ? null : Number(file.size),
        parentFolderId: folderId,
        parentPath,
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return entries;
}

interface TraversalResult {
  files: DriveEntry[];
  foldersVisited: number;
}

/**
 * Breadth-first walk of the whole tree under `rootFolderId`.
 *
 * Collects every non-folder entry, at any depth, before any ingestion begins, so
 * the run can report a total up front and a listing failure deep in the tree
 * surfaces before the first document is written.
 */
async function collectFilesRecursively(
  drive: drive_v3.Drive,
  rootFolderId: string
): Promise<TraversalResult> {
  const files: DriveEntry[] = [];
  // Guards against Drive's graph shape: multi-parent folders and shortcut loops
  // would otherwise make this queue cycle forever.
  const visitedFolderIds = new Set<string>([rootFolderId]);
  const queue: Array<{ id: string; path: string }> = [{ id: rootFolderId, path: "" }];
  let foldersVisited = 0;

  while (queue.length > 0) {
    const folder = queue.shift();
    if (!folder) break;

    foldersVisited += 1;
    const children = await listFolderChildren(drive, folder.id, folder.path);

    for (const child of children) {
      if (child.mimeType === FOLDER_MIME_TYPE) {
        if (visitedFolderIds.has(child.id)) {
          console.log(`  ↩  ${child.name}/ — already visited, not descending again`);
          continue;
        }
        visitedFolderIds.add(child.id);
        queue.push({
          id: child.id,
          path: folder.path ? `${folder.path}/${child.name}` : child.name,
        });
        continue;
      }
      files.push(child);
    }
  }

  return { files, foldersVisited };
}

/**
 * How a given Drive entry can be turned into text, if at all.
 *
 * `ingestMimeType` is what the pipeline's extractor table is keyed on in both
 * cases; `exportMimeType` is non-null only when Drive has to convert the file
 * server-side first.
 */
type FetchPlan =
  | { kind: "binary"; ingestMimeType: string }
  | { kind: "export"; ingestMimeType: string; exportMimeType: string }
  | { kind: "unsupported"; reason: string };

function planFetch(entry: DriveEntry): FetchPlan {
  const declared = entry.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (declared === SHORTCUT_MIME_TYPE) {
    return {
      kind: "unsupported",
      reason: "shortcut — sync the file's own location instead",
    };
  }

  const exportMimeType = WORKSPACE_EXPORT_MIME_TYPES[declared];
  if (exportMimeType) {
    return { kind: "export", ingestMimeType: exportMimeType, exportMimeType };
  }

  if (declared.startsWith("application/vnd.google-apps.")) {
    // Forms, Sites, Drawings, Jamboards, Apps Script: native types with no
    // text-bearing export target.
    return { kind: "unsupported", reason: `no text export for ${entry.mimeType}` };
  }

  const byExtension = MIME_BY_EXTENSION[extensionOf(entry.name)];
  // A markdown file uploaded as text/plain should still be tagged text/markdown.
  if (byExtension === "text/markdown") {
    return { kind: "binary", ingestMimeType: byExtension };
  }
  if (BINARY_MIME_TYPES[declared]) {
    return { kind: "binary", ingestMimeType: BINARY_MIME_TYPES[declared] };
  }
  if (byExtension) {
    return { kind: "binary", ingestMimeType: byExtension };
  }

  return { kind: "unsupported", reason: `unsupported type ${entry.mimeType}` };
}

/** Normalises whatever gaxios hands back into an ArrayBuffer. */
function toArrayBuffer(data: unknown): ArrayBuffer {
  if (Buffer.isBuffer(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  // Exports of text formats can arrive already decoded to a string.
  if (typeof data === "string") {
    const encoded = new TextEncoder().encode(data);
    return encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    ) as ArrayBuffer;
  }
  throw new Error(`Unexpected Drive response body of type ${typeof data}.`);
}

async function downloadBinaryFile(
  drive: drive_v3.Drive,
  fileId: string
): Promise<ArrayBuffer> {
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return toArrayBuffer(response.data);
}

/**
 * Converts a native Workspace file server-side and downloads the result.
 *
 * `files.export` accepts only `fileId` and `mimeType` — there is no
 * `supportsAllDrives` on this method, unlike `files.get`. Google caps an export
 * at 10 MB of converted content and fails the request beyond that, which is
 * reported as-is rather than silently truncating the document.
 */
async function exportWorkspaceFile(
  drive: drive_v3.Drive,
  fileId: string,
  exportMimeType: string
): Promise<ArrayBuffer> {
  const response = await drive.files.export(
    { fileId, mimeType: exportMimeType },
    { responseType: "arraybuffer" }
  );
  return toArrayBuffer(response.data);
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
 * every run into a full re-ingest of the whole tree.
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

type Outcome = "new" | "updated" | "unchanged" | "skipped";

interface SyncTotals {
  new: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  chunks: number;
  exported: number;
}

function displayName(entry: DriveEntry): string {
  return entry.parentPath ? `${entry.parentPath}/${entry.name}` : entry.name;
}

async function syncFile(
  drive: drive_v3.Drive,
  entry: DriveEntry,
  config: SyncConfig,
  totals: SyncTotals
): Promise<Outcome> {
  const label = displayName(entry);
  const plan = planFetch(entry);

  if (plan.kind === "unsupported") {
    console.log(`  ⏭  ${label} — ${plan.reason}`);
    totals.skipped += 1;
    return "skipped";
  }

  // Native Workspace files report no size, so the ceiling only ever applies to
  // binary uploads. Their export size is enforced by Google instead.
  if (config.maxBytes > 0 && entry.sizeBytes !== null && entry.sizeBytes > config.maxBytes) {
    console.log(
      `  ⏭  ${label} — ${entry.sizeBytes} bytes exceeds DRIVE_SYNC_MAX_BYTES (${config.maxBytes})`
    );
    totals.skipped += 1;
    return "skipped";
  }

  const existing = await findRegisteredDocument(entry.id);

  // The comparison is on Drive's own modifiedTime string, stored verbatim on the
  // previous ingestion. Comparing parsed dates instead would make an unchanged
  // file look changed whenever Drive alters its timestamp formatting.
  if (existing && existing.driveModifiedTime === entry.modifiedTime) {
    console.log(`  ✓  ${label} — unchanged (${entry.modifiedTime})`);
    totals.unchanged += 1;
    return "unchanged";
  }

  const isUpdate = existing !== null;
  const via = plan.kind === "export" ? ` via export → ${plan.exportMimeType}` : "";
  console.log(
    `  →  ${label} — ${isUpdate ? "updated in Drive" : "new"}${via} (${entry.modifiedTime})`
  );

  if (config.dryRun) {
    console.log(`     [dry-run] would ${isUpdate ? "re-ingest" : "ingest"} this file`);
    totals[isUpdate ? "updated" : "new"] += 1;
    return isUpdate ? "updated" : "new";
  }

  const bytes =
    plan.kind === "export"
      ? await exportWorkspaceFile(drive, entry.id, plan.exportMimeType)
      : await downloadBinaryFile(drive, entry.id);

  if (plan.kind === "export") {
    totals.exported += 1;
  }

  // Same guard the HTTP upload route applies. It sniffs PDF and DOCX only, so it
  // is a no-op for the text formats every export produces — harmless to call
  // uniformly, and it keeps binary downloads honest.
  assertMimeMatchesContent(new Uint8Array(bytes), plan.ingestMimeType);

  const text = await extractTextFromUpload(bytes, plan.ingestMimeType);
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
    filename: entry.name,
    mimeType: plan.ingestMimeType,
    text,
    classificationLevel: config.classificationLevel,
    uploadedByUserId: UPLOADED_BY_USER_ID,
    // Admin write level: required for the corpus INSERT policy, and independent
    // of the classification the chunks are stored at.
    uploadedByPermissionLevel: ADMIN_PERMISSION_LEVEL,
    source: SOURCE,
    extraMetadata: {
      // The two idempotency keys. Nothing else in this object is read back.
      drive_file_id: entry.id,
      drive_modified_time: entry.modifiedTime,
      // Root of the sync, unchanged in meaning from before recursion existed.
      drive_folder_id: config.folderId,
      // Where the file actually sits, now that the walk goes deeper than the root.
      drive_parent_folder_id: entry.parentFolderId,
      drive_path: label,
      drive_mime_type: entry.mimeType,
      drive_export_mime_type: plan.kind === "export" ? plan.exportMimeType : null,
      original_size_bytes: entry.sizeBytes,
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
  console.log(`  root folder:    ${config.folderId}`);
  console.log(`  classification: L${config.classificationLevel}`);
  console.log(`  max file size:  ${config.maxBytes} bytes (binary uploads only)`);
  if (config.dryRun) console.log("  mode:           DRY RUN (nothing is written)");
  console.log("");

  const drive = await createDriveClient();

  console.log("Walking the folder tree…");
  const { files, foldersVisited } = await collectFilesRecursively(drive, config.folderId);

  if (files.length === 0) {
    console.log(
      `No files found across ${foldersVisited} folder(s). ` +
        "Is the root shared with the service account?"
    );
    return;
  }

  console.log(`Found ${files.length} file(s) across ${foldersVisited} folder(s).\n`);

  const totals: SyncTotals = {
    new: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    chunks: 0,
    exported: 0,
  };

  // Sequential on purpose: each ingestion holds a document, its chunks and every
  // 768-float vector in memory, and they all contend for the same embedding
  // provider quota. Parallelising here buys throttling, not throughput.
  for (const entry of files) {
    try {
      await syncFile(drive, entry, config, totals);
    } catch (err) {
      // One unreadable file must not abandon the rest of the tree.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${displayName(entry)} — ${message}`);
      totals.failed += 1;
    }
  }

  console.log("\n─────────────────────────────────────────");
  console.log(`  folders:   ${foldersVisited}`);
  console.log(`  new:       ${totals.new}`);
  console.log(`  updated:   ${totals.updated}`);
  console.log(`  unchanged: ${totals.unchanged}`);
  console.log(`  skipped:   ${totals.skipped}`);
  console.log(`  failed:    ${totals.failed}`);
  console.log(`  exported:  ${totals.exported} (native Workspace files)`);
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
