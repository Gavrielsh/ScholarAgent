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
 * Usage:
 *   npx tsx scripts/ingest_directory.ts
 *   node --require ts-node/register --require tsconfig-paths/register scripts/ingest_directory.ts
 */

import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { extractTextFromUpload, ingestDocument } from "../lib/ingestion/uploader";
import { closePool } from "../lib/db/client";
import type { PermissionLevel } from "@/lib/auth/types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_DIRECTORY = path.join(process.cwd(), "local_data", "documents");

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
    await processDirectory(BASE_DIRECTORY);
  } catch (err) {
    console.error("Fatal error accessing base directory:", err);
  } finally {
    await closePool();
    console.log("\n✅  Ingestion complete. Database connection closed.");
  }
}

run().catch((err) => {
  console.error("Unhandled fatal error:", err);
  process.exit(1);
});
