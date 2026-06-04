import fs from "fs/promises";
import path from "path";
import { extractTextFromUpload, ingestDocument } from "../lib/ingestion/uploader";
import { closePool } from "../lib/db/client";
import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// Base directory for local documents
const BASE_DIRECTORY = path.join(process.cwd(), "local_data", "documents");

// Helper function to identify MIME Type by file extension
function getMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".csv": return "text/csv";
    default: return null;
  }
}

// Recursive function for deep directory scanning
async function processDirectory(currentPath: string) {
  // Read all entries in the directory (files and subdirectories)
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      console.log(`[DIR] Entering directory: ${fullPath}`);
      // If it's a directory - recursive call to traverse deeper
      await processDirectory(fullPath); 
    } else if (entry.isFile()) {
      // If it's a file - process it based on its extension
      const mimeType = getMimeType(entry.name);

      if (!mimeType) {
        console.warn(`[SKIPPED] Unsupported file type: ${fullPath}`);
        continue;
      }

      console.log(`[PROCESSING] ${fullPath}...`);
      
      try {
        const fileBuffer = await fs.readFile(fullPath);
        const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
        const text = await extractTextFromUpload(arrayBuffer, mimeType);

        // Extract the relative path (to keep the directory structure in the DB metadata)
        const relativePath = path.relative(BASE_DIRECTORY, fullPath);

        const result = await ingestDocument({
          filename: relativePath, 
          mimeType: mimeType,
          text: text,
          classificationLevel: 1, // TIP: You can set this dynamically based on the 'relativePath' or folder name
          uploadedByUserId: "system-batch-script",
        });

        console.log(`[SUCCESS] ${relativePath} -> Document ID: ${result.documentId} | Chunks: ${result.chunkCount}`);
        
      } catch (error) {
        console.error(`[ERROR] Failed to process ${fullPath}:`, error);
      }
    }
  }
}

async function run() {
  console.log(`Starting recursive ingestion from base directory: ${BASE_DIRECTORY}`);
  
  try {
    // Start the recursive scan from the root directory
    await processDirectory(BASE_DIRECTORY);
  } catch (error) {
    console.error("Fatal error accessing directory:", error);
  } finally {
    // Ensure the database connection pool is closed after completion
    await closePool();
    console.log("Ingestion complete. Database connection closed.");
  }
}

run();