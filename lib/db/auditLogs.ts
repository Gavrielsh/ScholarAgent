import { query } from "@/lib/db/client";

export async function insertRagAuditLog(row: {
  query: string;
  userId: string;
  retrievedChunkIds: string[];
  latencyMs: number;
}): Promise<void> {
  await query(
    `INSERT INTO audit_logs (query, user_id, retrieved_chunk_ids, latency_ms)
     VALUES ($1, $2, $3::uuid[], $4)`,
    [row.query, row.userId, row.retrievedChunkIds, row.latencyMs]
  );
}
