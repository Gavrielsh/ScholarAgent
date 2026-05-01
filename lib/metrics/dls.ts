import type { KnowledgeChunk, UserContext } from "@/lib/auth/types";

export interface DlsResult {
  score: number;            // percentage 0–100
  totalChunks: number;
  unauthorizedChunks: number;
  passed: boolean;          // true when score === 0
}

// Data Leakage Score (DLS) — novel security metric defined in the thesis.
//
// DLS = (unauthorized_chunks / total_retrieved_chunks) × 100
//
// A chunk is unauthorized when the user's permission level is greater than
// the chunk's classification level (i.e., the user lacks the required privilege).
// A DLS of 0% means the RLS layer is working correctly.
export function computeDls(user: UserContext, retrievedChunks: KnowledgeChunk[]): DlsResult {
  if (retrievedChunks.length === 0) {
    return { score: 0, totalChunks: 0, unauthorizedChunks: 0, passed: true };
  }

  const unauthorizedChunks = retrievedChunks.filter(
    (chunk) => user.permissionLevel > chunk.classificationLevel
  ).length;

  const score = (unauthorizedChunks / retrievedChunks.length) * 100;

  return {
    score,
    totalChunks: retrievedChunks.length,
    unauthorizedChunks,
    passed: score === 0,
  };
}
