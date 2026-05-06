// Baseline RAG — experimental configuration 1 of 3 (proposal §6.2).
//
// This is the reference/control system: a simple retrieve-then-generate
// pipeline with NO agentic layer, NO dynamic tool selection, and NO
// identity injection beyond the RLS permission level.
//
// Used to measure H1 (Context Precision gap) and H3 (Data Leakage Score)
// against the Agentic-RAG configurations.

import type { PermissionLevel, UserContext } from "@/lib/auth/types";
import { querySimilarDocuments } from "@/lib/db/pgvector";
import { getLlmAdapter } from "@/lib/llm/adapter";
import { computeDls, type DlsResult } from "@/lib/metrics/dls";
import type { KnowledgeChunk } from "@/lib/auth/types";

export interface BaselineRagInput {
  query: string;
  userContext: UserContext;
  retrievalLimit?: number;
}

export interface BaselineRagResult {
  answer: string;
  retrievedChunks: Array<{
    id: string;
    text: string;
    classificationLevel: PermissionLevel;
    similarity: number;
  }>;
  dls: DlsResult;
  latencyMs: number;
}

// Runs a single Baseline RAG query and returns the answer plus evaluation data.
// The caller is responsible for computing RAGAS scores from the returned fields.
export async function runBaselineRag(input: BaselineRagInput): Promise<BaselineRagResult> {
  const { query, userContext, retrievalLimit = 5 } = input;
  const startMs = Date.now();

  // Step 1 — Retrieve: pgvector similarity search inside an RLS transaction.
  const docs = await querySimilarDocuments(query, userContext.permissionLevel, retrievalLimit);

  // Step 2 — Compute DLS before filtering: measure what the DB returned vs
  // what the user is authorised to see. With correct RLS, DLS should be 0%.
  const chunksForDls: KnowledgeChunk[] = docs.map((d) => ({
    id: d.id,
    content: d.text,
    classificationLevel: d.classificationLevel,
  }));
  const dls = computeDls(userContext, chunksForDls);

  // Step 3 — Generate: pass retrieved context straight to the LLM.
  // No planner, no multi-step loop — this is intentionally simple.
  const contextBlock =
    docs.length > 0
      ? docs.map((d, i) => `[${i + 1}] ${d.text}`).join("\n\n")
      : "No relevant documents found in the knowledge base.";

  const adapter = getLlmAdapter();
  const answer = await adapter.generateText({
    messages: [
      {
        role: "system",
        // TODO: Translate/Adapt this system prompt to Hebrew for the organisation.
        content:
          "You are an educational assistant for the organisation. " +
          "Answer the question using ONLY the provided context. " +
          "If the context is insufficient, say so clearly.",
      },
      {
        role: "user",
        content: `Question: ${query}\n\nContext:\n${contextBlock}`,
      },
    ],
    temperature: 0.2,
  });

  return {
    answer,
    retrievedChunks: docs.map((d) => ({
      id: d.id,
      text: d.text,
      classificationLevel: d.classificationLevel,
      similarity: d.similarity,
    })),
    dls,
    latencyMs: Date.now() - startMs,
  };
}
