/**
 * ingest_directory.ts — Batch ingestion script for ScholarAgent
 *
 * Recursively scans `local_data/documents/` and ingests every supported file
 * into the pgvector knowledge base.
 *
 * Supported extensions: .pdf  .txt  .docx  .md  .csv
 *
 * Classification level is inferred from the TOP-LEVEL folder name inside
 * `local_data/documents/`. Place documents in the matching subfolder:
 *
 *   local_data/documents/
 *     l0/   (or: admin/   0/)   → classificationLevel 0  (Admin only)
 *     l1/   (or: manager/ 1/)   → classificationLevel 1  (Manager+)
 *     l2/   (or: staff/   2/)   → classificationLevel 2  (Staff+)
 *     l3/   (or: volunteer/3/)  → classificationLevel 3  (All roles) ← default
 *
 * Files placed directly in the root (not in a subfolder) default to level 3.
 *
 * A different root can be given with --base, and levels are then inferred from
 * the top-level folder inside THAT root:
 *
 *   npm run ingest -- --base local_data/eval_corpus
 *     → local_data/eval_corpus/L0/*.md  becomes classificationLevel 0
 *
 * Without --base, a corpus living outside local_data/documents is simply never
 * scanned; and pointing the old hardcoded root at its parent would make the
 * top-level folder "eval_corpus", which is not in FOLDER_LEVEL_MAP, so every
 * file would silently default to level 3. That is why the root is a flag rather
 * than something to edit by hand.
 *
 * Usage:
 *   npx tsx scripts/ingest_directory.ts
 *   npm run ingest -- --base local_data/eval_corpus
 */

import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { extractTextFromUpload, ingestDocument } from "@/lib/domain/ingestion/pipeline";
import { closePool } from "@/lib/core/db";
import type { PermissionLevel } from "@/lib/security/auth";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BASE = path.join("local_data", "documents");

/**
 * Ingestion root. Levels are inferred from the top-level folder inside it, so
 * changing the root changes which folder names carry the classification.
 *
 * Resolved against cwd and required to stay inside the project, so a stray
 * --base cannot walk the filesystem and ingest arbitrary files into the corpus.
 */
function resolveBaseDirectory(argv: string[]): string {
  const i = argv.indexOf("--base");
  const requested = i === -1 ? DEFAULT_BASE : argv[i + 1];

  if (i !== -1 && (!requested || requested.startsWith("-"))) {
    throw new Error("--base needs a directory path, e.g. --base local_data/eval_corpus");
  }

  const root = process.cwd();
  const resolved = path.resolve(root, requested as string);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`--base must stay inside the project; got ${resolved}`);
  }
  return resolved;
}

const BASE_DIRECTORY = resolveBaseDirectory(process.argv.slice(2));

// ---------------------------------------------------------------------------
// MIME type resolution
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  ".pdf":  "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt":  "text/plain",
  ".md":   "text/markdown",
  ".csv":  "text/csv",
};

function getMimeType(filename: string): string | null {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Classification level inference from folder hierarchy
// ---------------------------------------------------------------------------

/**
 * Maps well-known folder name variants to their PermissionLevel numeric value.
 * Matching is case-insensitive against the TOP-LEVEL subfolder inside BASE_DIRECTORY.
 */
const FOLDER_LEVEL_MAP: Record<string, PermissionLevel> = {
  "0": 0, l0: 0, admin: 0, administrator: 0, headquarters: 0,
  "1": 1, l1: 1, manager: 1, managers: 1, management: 1,
  "2": 2, l2: 2, staff: 2, counselor: 2, counselors: 2,
  "3": 3, l3: 3, volunteer: 3, volunteers: 3, mentor: 3, mentors: 3,
};

/**
 * Returns the PermissionLevel for a file based on the top-level subfolder
 * of its path relative to BASE_DIRECTORY. Defaults to 3 (least privileged).
 */
function inferClassificationLevel(relativePath: string): PermissionLevel {
  // relativePath example: "l0/subdir/file.pdf"  or  "file.pdf"
  const topFolder = relativePath.split(path.sep)[0]?.toLowerCase() ?? "";
  return FOLDER_LEVEL_MAP[topFolder] ?? 3;
}

// ---------------------------------------------------------------------------
// Recursive directory processor
// ---------------------------------------------------------------------------

/**
 * Files that were attempted and failed. Tracked so the process can exit non-zero:
 * a script that logs `[ERR]` and still exits 0 reads as success to CI and to any
 * cron wrapper, which is how a half-ingested corpus goes unnoticed.
 */
const failedFiles: string[] = [];

async function processDirectory(currentPath: string): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      console.log(`[DIR]  Entering: ${fullPath}`);
      await processDirectory(fullPath);
      continue;
    }

    if (!entry.isFile()) continue;

    const mimeType = getMimeType(entry.name);
    if (!mimeType) {
      console.warn(`[SKIP] Unsupported extension — ${fullPath}`);
      continue;
    }

    // Relative path from the documents root (used for metadata and level lookup).
    const relativePath = path.relative(BASE_DIRECTORY, fullPath);
    const classificationLevel = inferClassificationLevel(relativePath);

    console.log(
      `[PROC] ${relativePath} (classificationLevel=${classificationLevel}, mime=${mimeType})`
    );

    try {
      const fileBuffer = await fs.readFile(fullPath);
      // Construct a proper ArrayBuffer slice that shares the same backing memory.
      const arrayBuffer = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength
      );

      const text = await extractTextFromUpload(arrayBuffer, mimeType);

      if (!text.trim()) {
        console.warn(`[SKIP] No extractable text — ${relativePath}`);
        continue;
      }

      const result = await ingestDocument({
        filename: relativePath,
        mimeType,
        text,
        classificationLevel,
        uploadedByUserId: "system-batch-script",
        uploadedByPermissionLevel: 0,
        source: "directory",
        extraMetadata: {
          source_path: relativePath,
          required_role: classificationLevel,
        },
      });

      console.log(
        `[OK]   ${relativePath} → document_id=${result.documentId}  chunks=${result.chunkCount}` +
        (result.failures.length > 0 ? `  (${result.failures.length} chunk failures)` : "")
      );
    } catch (err) {
      failedFiles.push(relativePath);
      console.error(`[ERR]  ${relativePath} —`, err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log(`\n📂  Starting recursive ingestion from: ${BASE_DIRECTORY}\n`);

  try {
    const stat = await fs.stat(BASE_DIRECTORY).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(
        `Ingestion root does not exist: ${BASE_DIRECTORY}. ` +
          "Pass --base <dir> to point at the corpus you mean to ingest."
      );
    }

    // Levels come from the folder names directly inside the root. Reported up
    // front because a mis-tiered corpus produces a plausible-looking benchmark
    // that measures nothing.
    const top = (await fs.readdir(BASE_DIRECTORY, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => `${e.name} → level ${inferClassificationLevel(e.name)}`);
    if (top.length > 0) {
      console.log("   Tier mapping from folder names:");
      for (const line of top) console.log(`     ${line}`);
      console.log();
    }

    await processDirectory(BASE_DIRECTORY);
  } catch (err) {
    console.error("Fatal error accessing base directory:", err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }

  if (failedFiles.length > 0) {
    process.exitCode = 1;
    console.error(`\n❌  Ingestion finished with ${failedFiles.length} failed file(s):`);
    for (const file of failedFiles) console.error(`     - ${file}`);
  } else if (process.exitCode === 1) {
    console.error("\n❌  Ingestion aborted. Database connection closed.");
  } else {
    console.log("\n✅  Ingestion complete. Database connection closed.");
  }
}

run().catch((err) => {
  console.error("Unhandled fatal error:", err);
  process.exit(1);
});
