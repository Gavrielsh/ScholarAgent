/**
 * reconcile_documents.ts — repairs documents that are registered but not embedded.
 *
 * `ingested_documents` (migration 007) is the registry; the chunks live in
 * `knowledge_base`, tagged with `metadata->>'document_id'`. The first-ingestion
 * path writes both halves in one transaction, so the two cannot diverge there —
 * but they can diverge afterwards: the document-deleted webhook removes chunks
 * without touching the registry row, an interrupted migration or a manual DELETE
 * on knowledge_base does the same, and a document registered by any future path
 * that embeds asynchronously starts life with no chunks at all.
 *
 * A document in that state is invisible to RAG while looking perfectly ingested
 * to every admin report. This script finds them (NOT EXISTS against
 * knowledge_base), recovers the source text, and rebuilds the chunks through the
 * same modules the live pipeline uses — piiRedact → chunker → embeddings — so a
 * reconciled document is byte-for-byte what normal ingestion would have produced.
 *
 * SOURCE TEXT RESOLUTION, in order:
 *   1. Inline text on the document row (`metadata.extracted_text` / `raw_text`).
 *   2. A file under the source directory (default `local_data/documents`), located
 *      via `metadata.source_path` / `local_path` / `file_path`, then the row's
 *      `filename`, then a unique basename match anywhere in the tree.
 *   3. Re-download from the WhatsApp Graph API by `external_media_id`, only with
 *      --allow-media-download (Meta's media handles expire within days, so this
 *      usually fails and costs an API call to find out).
 *
 * IDEMPOTENCY. Safe to re-run, by three independent mechanisms:
 *   · the scan only returns documents with zero chunks;
 *   · chunk ids are derived from (document_id, chunk_index), so the bulk insert's
 *     ON CONFLICT (id) DO UPDATE overwrites in place instead of duplicating;
 *   · the write transaction locks the registry row and re-checks emptiness inside
 *     the lock, so two concurrent runs cannot both insert.
 *
 * Usage:
 *   npm run reconcile
 *   npx tsx scripts/reconcile_documents.ts --dry-run
 *   npx tsx scripts/reconcile_documents.ts --limit=25 --verbose
 *   npx tsx scripts/reconcile_documents.ts --document-id=<uuid>
 *   npx tsx scripts/reconcile_documents.ts --source-dir=./local_data/documents
 *   npx tsx scripts/reconcile_documents.ts --allow-media-download
 *
 * Exits 1 if any document failed, so a cron or CI wrapper notices.
 */

// dotenv runs before the library imports below on purpose: several of them read
// process.env at module scope, and ts-node/tsx emit CommonJS requires in source
// order (same pattern as scripts/ingest_directory.ts).
import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFile, readdir } from "node:fs/promises";

import {
  backfillDocumentChunks,
  findDocumentsMissingChunks,
  markDocumentReconcileFailure,
  type DocumentChunkRecord,
  type DocumentRegistryRow,
} from "@/lib/db/pgvector";
import { closePool } from "@/lib/db/client";
import { chunkText, type Chunk } from "@/lib/ingestion/chunker";
import { embedTextBatch } from "@/lib/ingestion/embeddings";
import { redactPii } from "@/lib/ingestion/piiRedact";
import { extractTextFromUpload } from "@/lib/ingestion/uploader";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { downloadWhatsAppMedia } from "@/lib/whatsapp/mediaDownload";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE_DIR = path.join(process.cwd(), "local_data", "documents");
const DEFAULT_LIMIT = Number(process.env.RECONCILE_LIMIT ?? 100);

/** Same slice size and pacing as the WhatsApp ingestion worker: one large batch
 *  is itself what trips the free Gemini tier's per-minute quota, and every retry
 *  of it re-sends every chunk. */
const EMBED_BATCH_SIZE = Number(
  process.env.RECONCILE_EMBED_BATCH_SIZE ?? process.env.DOCUMENT_EMBED_BATCH_SIZE ?? 16
);
const EMBED_BATCH_PAUSE_MS = Number(
  process.env.RECONCILE_EMBED_PAUSE_MS ?? process.env.DOCUMENT_EMBED_BATCH_PAUSE_MS ?? 250
);
/** Backstop against one 900-page PDF consuming an entire quota window. */
const MAX_CHUNKS_PER_DOCUMENT = Number(
  process.env.RECONCILE_MAX_CHUNKS ?? process.env.DOCUMENT_MAX_CHUNKS ?? 400
);

/** Metadata keys that may carry the already-extracted text of the document. */
const INLINE_TEXT_KEYS = ["extracted_text", "raw_text", "text", "content"] as const;
/** Metadata keys that may carry a path to the original file. */
const SOURCE_PATH_KEYS = ["source_path", "local_path", "file_path", "relative_path"] as const;

/** Mirrors the extractor table in lib/ingestion/uploader.ts. */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};
const SUPPORTED_MIME_TYPES = new Set(Object.values(MIME_BY_EXT));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

interface Options {
  dryRun: boolean;
  limit: number;
  documentId: string | null;
  sourceDir: string;
  allowMediaDownload: boolean;
  verbose: boolean;
}

const USAGE = `
Usage: npx tsx scripts/reconcile_documents.ts [options]

  --dry-run                 Report what would be rebuilt; embed and write nothing.
  --limit=N                 Maximum documents to process (default ${DEFAULT_LIMIT}).
  --document-id=<uuid>      Reconcile a single document.
  --source-dir=<path>       Where to look for original files (default local_data/documents).
  --allow-media-download    Permit re-download from the WhatsApp Graph API.
  --verbose                 Log per-chunk and resolution detail.
  --help                    Show this message.
`.trimStart();

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    limit: DEFAULT_LIMIT,
    documentId: null,
    sourceDir: process.env.RECONCILE_SOURCE_DIR
      ? path.resolve(process.env.RECONCILE_SOURCE_DIR)
      : DEFAULT_SOURCE_DIR,
    allowMediaDownload: false,
    verbose: false,
  };

  for (const arg of argv) {
    const [flag, rawValue] = arg.split("=", 2);
    switch (flag) {
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--allow-media-download":
        options.allowMediaDownload = true;
        break;
      case "--limit": {
        const parsed = Number.parseInt(rawValue ?? "", 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--limit expects a positive integer, got "${rawValue}".`);
        }
        options.limit = parsed;
        break;
      }
      case "--document-id": {
        const value = (rawValue ?? "").trim();
        // Validated here rather than relying on the $1::uuid cast, so a typo
        // fails with this message instead of a Postgres syntax error.
        if (!UUID_PATTERN.test(value)) {
          throw new Error(`--document-id expects a UUID, got "${rawValue}".`);
        }
        options.documentId = value;
        break;
      }
      case "--source-dir": {
        const value = (rawValue ?? "").trim();
        if (!value) {
          throw new Error("--source-dir expects a path.");
        }
        options.sourceDir = path.resolve(value);
        break;
      }
      default:
        throw new Error(`Unknown argument "${arg}".\n\n${USAGE}`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Source text resolution
// ---------------------------------------------------------------------------

/** A source the reconciler declined to use, with the reason, for the report. */
class UnresolvableDocumentError extends Error {}

interface ResolvedSource {
  text: string;
  /** Where the text came from, recorded in every rebuilt chunk's metadata. */
  origin: string;
}

function readStringField(
  metadata: Record<string, unknown> | null,
  keys: readonly string[]
): { key: string; value: string } | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return { key, value };
    }
  }
  return null;
}

/**
 * Lazy basename → paths index over the source tree.
 *
 * Built once and only if some document needs it: the corpus directory holds
 * hundreds of files across deep folders, and walking it per document turns a
 * 100-document run into 100 full traversals.
 */
class SourceFileIndex {
  private index: Map<string, string[]> | null = null;

  constructor(private readonly root: string) {}

  async lookupUnique(basename: string): Promise<string | null> {
    const index = await this.build();
    const matches = index.get(basename.toLowerCase()) ?? [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      // Embedding the wrong file under a document's id is worse than leaving the
      // document unreconciled: the content would be misattributed and would
      // inherit that document's classification level.
      throw new UnresolvableDocumentError(
        `${matches.length} files named "${basename}" under ${this.root}; ` +
          "pass metadata.source_path or --document-id to disambiguate."
      );
    }
    return null;
  }

  private async build(): Promise<Map<string, string[]>> {
    if (this.index) return this.index;

    const index = new Map<string, string[]>();
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // Unreadable or missing directory — nothing to index.
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const key = entry.name.toLowerCase();
        const bucket = index.get(key);
        if (bucket) bucket.push(full);
        else index.set(key, [full]);
      }
    };

    await walk(this.root);
    this.index = index;
    return index;
  }
}

/**
 * Resolves a candidate path from the database against the source directory.
 *
 * Returns null when the candidate escapes that directory. `metadata` is data, not
 * code: a `source_path` of `../../../etc/passwd` written by any path that can
 * insert a document row would otherwise make this script read and then *embed*
 * an arbitrary file into a retrievable corpus.
 */
function resolveInsideSourceDir(candidate: string, sourceDir: string): string | null {
  // Registry rows are written on Linux and this script may run on Windows, so
  // both separators have to be accepted.
  const segments = candidate.split(/[\\/]+/).filter((s) => s && s !== ".");
  if (segments.length === 0) return null;

  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(sourceDir, ...segments);

  const root = path.resolve(sourceDir);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  return inside ? resolved : null;
}

function mimeTypeFor(filePath: string, declaredMimeType: string): string {
  if (SUPPORTED_MIME_TYPES.has(declaredMimeType)) return declaredMimeType;
  const byExtension = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (byExtension) return byExtension;
  throw new UnresolvableDocumentError(
    `Unsupported type for extraction: declared "${declaredMimeType || "<none>"}", ` +
      `extension "${path.extname(filePath) || "<none>"}".`
  );
}

async function extractFromFile(filePath: string, declaredMimeType: string): Promise<string> {
  const mimeType = mimeTypeFor(filePath, declaredMimeType);
  const buffer = await readFile(filePath);
  // A slice that shares the same backing memory, as the extractors expect.
  const bytes = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  return extractTextFromUpload(bytes, mimeType);
}

async function resolveFromLocalFile(
  document: DocumentRegistryRow,
  options: Options,
  fileIndex: SourceFileIndex
): Promise<ResolvedSource | null> {
  const declaredPath = readStringField(document.metadata, SOURCE_PATH_KEYS);
  const candidates = [declaredPath?.value, document.filename].filter(
    (value): value is string => Boolean(value && value.trim())
  );

  for (const candidate of candidates) {
    const resolved = resolveInsideSourceDir(candidate, options.sourceDir);
    if (!resolved) {
      logWarn("reconcile_source_path_rejected", "Candidate path escapes the source directory.", {
        documentId: document.documentId,
        candidate,
        sourceDir: options.sourceDir,
      });
      continue;
    }
    try {
      const text = await extractFromFile(resolved, document.mimeType);
      if (text.trim()) {
        return { text, origin: `file:${path.relative(options.sourceDir, resolved)}` };
      }
    } catch (err) {
      if (err instanceof UnresolvableDocumentError) throw err;
      if (options.verbose) {
        console.log(
          `        · candidate ${candidate} unusable — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Last resort: a unique file with this basename anywhere under the source tree.
  // Covers documents whose stored filename lost its directory prefix.
  const basename = path.basename(document.filename.replace(/[\\/]+$/, ""));
  if (!basename) return null;

  const found = await fileIndex.lookupUnique(basename);
  if (!found) return null;

  const text = await extractFromFile(found, document.mimeType);
  if (!text.trim()) return null;
  return { text, origin: `file:${path.relative(options.sourceDir, found)}` };
}

async function resolveFromWhatsAppMedia(
  document: DocumentRegistryRow,
  options: Options
): Promise<ResolvedSource | null> {
  if (!options.allowMediaDownload || !document.externalMediaId) return null;

  const media = await downloadWhatsAppMedia(document.externalMediaId);
  const mimeType = SUPPORTED_MIME_TYPES.has(document.mimeType)
    ? document.mimeType
    : media.mimeType && SUPPORTED_MIME_TYPES.has(media.mimeType)
      ? media.mimeType
      : document.mimeType;

  const text = await extractTextFromUpload(media.bytes, mimeType);
  if (!text.trim()) return null;
  return { text, origin: `whatsapp_media:${document.externalMediaId}` };
}

async function resolveSourceText(
  document: DocumentRegistryRow,
  options: Options,
  fileIndex: SourceFileIndex
): Promise<ResolvedSource> {
  const inline = readStringField(document.metadata, INLINE_TEXT_KEYS);
  if (inline) {
    return { text: inline.value, origin: `metadata:${inline.key}` };
  }

  const fromFile = await resolveFromLocalFile(document, options, fileIndex);
  if (fromFile) return fromFile;

  const fromMedia = await resolveFromWhatsAppMedia(document, options);
  if (fromMedia) return fromMedia;

  const mediaHint =
    document.externalMediaId && !options.allowMediaDownload
      ? " Re-run with --allow-media-download to try the Graph API handle."
      : "";
  throw new UnresolvableDocumentError(
    `No source text: nothing inline in metadata and no readable file for "${document.filename}" ` +
      `under ${options.sourceDir}.${mediaHint}`
  );
}

// ---------------------------------------------------------------------------
// Chunking + embedding
// ---------------------------------------------------------------------------

/** REUSE: redactPii, then the Hebrew/Latin-aware semantic chunker. */
function buildChunks(text: string, document: DocumentRegistryRow): Chunk[] {
  // chunkText redacts internally too — idempotent, and doing it here means the
  // emptiness check below runs on already-masked text.
  const chunks = chunkText(redactPii(text)).filter((chunk) => chunk.text.trim().length > 0);

  if (chunks.length === 0) {
    throw new UnresolvableDocumentError(
      `Chunking produced nothing usable for "${document.filename}".`
    );
  }
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new UnresolvableDocumentError(
      `${chunks.length} chunks exceeds the ${MAX_CHUNKS_PER_DOCUMENT}-chunk ceiling ` +
        "(raise RECONCILE_MAX_CHUNKS to allow it)."
    );
  }
  return chunks;
}

/**
 * Embeds every chunk in slices, preserving index alignment with `chunks`.
 *
 * `embedTextBatch` guarantees alignment within a slice; concatenating slices in
 * order preserves it across them. That alignment is load-bearing — a shifted
 * vector attaches the wrong embedding to the wrong text and silently poisons
 * retrieval for the life of the row.
 */
async function embedChunksInSlices(chunks: Chunk[], options: Options): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
    const slice = chunks.slice(start, start + EMBED_BATCH_SIZE);
    const batch = await embedTextBatch(slice.map((c) => c.text));

    if (batch.length !== slice.length) {
      throw new Error(`Embedding count mismatch: got ${batch.length}, expected ${slice.length}.`);
    }
    vectors.push(...batch);

    if (options.verbose) {
      console.log(`        · embedded ${vectors.length}/${chunks.length} chunks`);
    }

    const hasMore = start + EMBED_BATCH_SIZE < chunks.length;
    if (hasMore && EMBED_BATCH_PAUSE_MS > 0) {
      await sleep(EMBED_BATCH_PAUSE_MS);
    }
  }

  return vectors;
}

// ---------------------------------------------------------------------------
// Per-document reconciliation
// ---------------------------------------------------------------------------

interface Metrics {
  documentsScanned: number;
  documentsReconciled: number;
  chunksCreated: number;
  documentsSkipped: number;
  documentsAlreadyPresent: number;
  documentsFailed: number;
}

type Outcome = "reconciled" | "skipped" | "already_present" | "failed" | "dry_run";

async function reconcileDocument(
  document: DocumentRegistryRow,
  options: Options,
  fileIndex: SourceFileIndex,
  metrics: Metrics
): Promise<Outcome> {
  const label = `${document.filename} (${document.documentId})`;
  console.log(`  → ${label}`);

  let source: ResolvedSource;
  let chunks: Chunk[];
  try {
    source = await resolveSourceText(document, options, fileIndex);
    chunks = buildChunks(source.text, document);
  } catch (err) {
    // A source problem is not going to fix itself on the next run, so it is
    // recorded on the row rather than only in this run's log.
    const reason = err instanceof Error ? err.message : String(err);
    const isUnresolvable = err instanceof UnresolvableDocumentError;

    if (isUnresolvable) {
      logWarn("reconcile_document_skipped", reason, {
        documentId: document.documentId,
        filename: document.filename,
        source: document.source,
      });
    } else {
      logError("reconcile_document_source_failed", err, {
        documentId: document.documentId,
        filename: document.filename,
      });
    }

    if (!options.dryRun) {
      await markDocumentReconcileFailure(document.documentId, reason);
    }
    console.log(`    ${isUnresolvable ? "SKIP" : "FAIL"}  ${reason}`);
    metrics[isUnresolvable ? "documentsSkipped" : "documentsFailed"] += 1;
    return isUnresolvable ? "skipped" : "failed";
  }

  if (options.dryRun) {
    console.log(
      `    DRY   would rebuild ${chunks.length} chunk(s) from ${source.origin} ` +
        `at level L${document.classificationLevel}`
    );
    return "dry_run";
  }

  const vectors = await embedChunksInSlices(chunks, options);
  const records: DocumentChunkRecord[] = chunks.map((chunk, i) => ({
    text: chunk.text,
    chunk,
    embedding: vectors[i],
  }));

  const result = await backfillDocumentChunks({
    documentId: document.documentId,
    filename: document.filename,
    mimeType: document.mimeType,
    uploadedByUserId: document.uploadedByUserId,
    classificationLevel: document.classificationLevel,
    chunkMetadata: {
      source: document.source,
      organization_id: document.metadata?.organization_id ?? null,
      ...(document.externalMediaId ? { wa_media_id: document.externalMediaId } : {}),
      ...(document.externalMessageId ? { wa_message_id: document.externalMessageId } : {}),
      original_size_bytes: document.sizeBytes,
      reconciled: true,
      reconciled_from: source.origin,
    },
    chunks: records,
  });

  if (result.alreadyPresent) {
    console.log("    NOOP  chunks appeared while this run was embedding; nothing written");
    logInfo("reconcile_document_raced", "Another writer populated the document first.", {
      documentId: document.documentId,
      chunkCount: chunks.length,
    });
    metrics.documentsAlreadyPresent += 1;
    return "already_present";
  }

  console.log(`    OK    ${result.insertedChunkIds.length} chunk(s) from ${source.origin}`);
  logInfo("reconcile_document_completed", "Rebuilt chunks for a registered document.", {
    documentId: document.documentId,
    filename: document.filename,
    source: document.source,
    origin: source.origin,
    classificationLevel: document.classificationLevel,
    chunkCount: result.insertedChunkIds.length,
    previousChunkCount: document.chunkCount,
  });

  metrics.documentsReconciled += 1;
  metrics.chunksCreated += result.insertedChunkIds.length;
  return "reconciled";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const metrics: Metrics = {
    documentsScanned: 0,
    documentsReconciled: 0,
    chunksCreated: 0,
    documentsSkipped: 0,
    documentsAlreadyPresent: 0,
    documentsFailed: 0,
  };

  // Ctrl-C finishes the document in flight and still prints the summary; killing
  // mid-transaction would be safe (it rolls back) but the operator would lose the
  // report of everything already done.
  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log("\n⏹  Stop requested — finishing the current document…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log("\n🔎  Scanning ingested_documents for documents with no chunks…");
  console.log(`    source dir: ${options.sourceDir}`);
  console.log(
    `    limit: ${options.limit}${options.documentId ? `  ·  document: ${options.documentId}` : ""}` +
      `${options.dryRun ? "  ·  DRY RUN" : ""}\n`
  );

  const fileIndex = new SourceFileIndex(options.sourceDir);

  try {
    const documents = await findDocumentsMissingChunks({
      limit: options.limit,
      documentId: options.documentId,
    });
    metrics.documentsScanned = documents.length;

    if (documents.length === 0) {
      console.log("  Nothing to reconcile — every registered document has chunks.");
    }

    for (const document of documents) {
      if (stopRequested) {
        console.log("  Interrupted before the remaining documents were processed.");
        break;
      }
      try {
        await reconcileDocument(document, options, fileIndex, metrics);
      } catch (err) {
        // Embedding or database failure: transient by nature (quota, network,
        // lock), so the run continues and the next invocation retries this one.
        const reason = err instanceof Error ? err.message : String(err);
        logError("reconcile_document_failed", err, {
          documentId: document.documentId,
          filename: document.filename,
        });
        console.log(`    FAIL  ${reason}`);
        metrics.documentsFailed += 1;
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await closePool();
  }

  const elapsedMs = Date.now() - startedAt;

  console.log("\n───────────────────────────────────────────────");
  console.log(`  documents scanned   : ${metrics.documentsScanned}`);
  console.log(`  documents repaired  : ${metrics.documentsReconciled}`);
  console.log(`  chunks created      : ${metrics.chunksCreated}`);
  console.log(`  skipped (no source) : ${metrics.documentsSkipped}`);
  console.log(`  already populated   : ${metrics.documentsAlreadyPresent}`);
  console.log(`  failed              : ${metrics.documentsFailed}`);
  console.log(`  elapsed             : ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log("───────────────────────────────────────────────\n");

  logInfo("reconcile_run_completed", "Document reconciliation finished.", {
    ...metrics,
    elapsedMs,
    dryRun: options.dryRun,
    interrupted: stopRequested,
  });

  if (metrics.documentsFailed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  logError("reconcile_run_fatal", err);
  console.error("Reconciliation aborted:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
