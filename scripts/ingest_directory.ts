import fs from "fs/promises";
import path from "path";
import { extractTextFromUpload, ingestDocument } from "../lib/ingestion/uploader";
import { closePool } from "../lib/db/client";

// הנתיב לתיקייה שבה נמצאים המסמכים שלך (שנה בהתאם לצורך)
const DIRECTORY = path.join(process.cwd(), "local_data", "documents");

// פונקציית עזר לזיהוי MIME Type לפי סיומת הקובץ
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

async function run() {
  console.log(`Starting ingestion from directory: ${DIRECTORY}`);
  
  try {
    const files = await fs.readdir(DIRECTORY);
    
    for (const file of files) {
      const filePath = path.join(DIRECTORY, file);
      const mimeType = getMimeType(file);

      if (!mimeType) {
        console.warn(`[SKIPPED] Unsupported file type: ${file}`);
        continue;
      }

      console.log(`[PROCESSING] ${file}...`);
      
      try {
        // קריאת הקובץ מהדיסק
        const fileBuffer = await fs.readFile(filePath);
        // המרה ל-ArrayBuffer כפי שהפונקציה שלך דורשת
        const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);

        // חילוץ טקסט בעזרת הפונקציה שלך מ-uploader.ts
        const text = await extractTextFromUpload(arrayBuffer, mimeType);

        // שמירה והמרה לווקטורים ב-DB
        const result = await ingestDocument({
          filename: file,
          mimeType: mimeType,
          text: text,
          classificationLevel: 1, // *חשוב: עדכן את הערך הזה בהתאם ל-Enum של PermissionLevel במערכת שלך*
          uploadedByUserId: "system-batch-script", // מזהה פיקטיבי שמעיד שההעלאה בוצעה אוטומטית
        });

        console.log(`[SUCCESS] ${file} -> Document ID: ${result.documentId} | Chunks: ${result.chunkCount}`);
        
      } catch (error) {
        console.error(`[ERROR] Failed to process ${file}:`, error);
      }
    }
  } catch (error) {
    console.error("Fatal error accessing directory:", error);
  } finally {
    // קריטי: סגירת חיבור ה-Postgres כדי שהסקריפט יסיים את הריצה ולא ייתקע באוויר
    await closePool();
    console.log("Ingestion complete. Database connection closed.");
  }
}

run();