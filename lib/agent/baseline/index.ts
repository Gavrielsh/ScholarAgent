// Baseline RAG — control configuration for comparative evaluation (proposal §6.2).
// Retrieve -> optional cross-encoder re-rank -> single LLM call. No LangGraph planner loop.

import type { PermissionLevel, UserContext } from "@/lib/auth/types";
import { ROLE_DESCRIPTIONS } from "@/lib/auth/types";
import type { ChatMessage } from "@/lib/agent/state";
import { insertRagAuditLog } from "@/lib/db/auditLogs";
import { DEFAULT_RETRIEVAL_OVERFETCH, querySimilarDocuments, type SimilarDocument } from "@/lib/db/pgvector";
import { getLlmAdapter } from "@/lib/llm/adapter";
import { computeDls, type DlsResult } from "@/lib/metrics/dls";
import type { KnowledgeChunk } from "@/lib/auth/types";
import type { LlmMessage } from "@/lib/llm/types";
import { defaultScoreReranker, type DocumentReranker, type RerankCandidate } from "@/lib/agent/baseline/reranker";
import {
  containsMandatoryHandoffSignals,
  MANDATORY_HANDOFF_RESPONSE_HE,
} from "@/lib/agent/baseline/safetySignals";
import { startBaselineRagTrace } from "@/lib/observability/tracing";

function isConversationMessage(message: ChatMessage): message is ChatMessage & {
  role: "user" | "assistant";
} {
  return message.role === "user" || message.role === "assistant";
}

export interface BaselineRagInput {
  query: string;
  userContext: UserContext;
  priorMessages?: ChatMessage[];
  /** Final chunk count passed to the LLM after hybrid retrieval + re-ranking (default 5). */
  retrievalLimit?: number;
  /** Optional cross-encoder / hosted reranker — defaults to score-based top-K. */
  reranker?: DocumentReranker;
}

export interface BaselineRagResult {
  answer: string;
  retrievedChunks: Array<{
    id: string;
    text: string;
    classificationLevel: PermissionLevel;
    similarity: number;
    rrfScore?: number;
  }>;
  dls: DlsResult;
  latencyMs: number;
}

const PROMPT_INJECTION_RESPONSE_HE =
  "לא ניתן לעבד את הבקשה מטעמי בטיחות. נסו להסיר הוראות מערכת או ניסיונות שינוי התנהגות.";

function toCandidates(docs: SimilarDocument[]): RerankCandidate[] {
  return docs.map((d) => ({
    id: d.id,
    text: d.text,
    metadata: d.metadata,
    classificationLevel: d.classificationLevel,
    similarity: d.similarity,
    rrfScore: d.rrfScore,
  }));
}

function fromCandidates(c: RerankCandidate[]): BaselineRagResult["retrievedChunks"] {
  return c.map((d) => ({
    id: d.id,
    text: d.text,
    classificationLevel: d.classificationLevel,
    similarity: d.similarity,
    rrfScore: d.rrfScore,
  }));
}

export async function runBaselineRag(input: BaselineRagInput): Promise<BaselineRagResult> {
  const { query, userContext, priorMessages = [], retrievalLimit = 5 } = input;
  const reranker = input.reranker ?? defaultScoreReranker;
  const startMs = Date.now();

  const trace = await startBaselineRagTrace({
    userId: userContext.userId,
    query,
    permissionLevel: userContext.permissionLevel,
  });

  const finish = async (
    payload: BaselineRagResult,
    log?: { safety?: boolean; injection?: boolean }
  ): Promise<BaselineRagResult> => {
    if (log?.safety) {
      console.error("baseline_rag.safety_handoff", { userId: userContext.userId });
    }
    if (log?.injection) {
      console.error("baseline_rag.prompt_injection_blocked", { userId: userContext.userId });
    }
    try {
      await insertRagAuditLog({
        query,
        userId: userContext.userId,
        retrievedChunkIds: payload.retrievedChunks.map((c) => c.id),
        latencyMs: Date.now() - startMs,
      });
    } catch (err) {
      console.error("audit_logs insert failed:", err);
    }
    trace.endRoot({
      answer: payload.answer,
      chunkIds: payload.retrievedChunks.map((c) => c.id),
      latencyMs: payload.latencyMs,
    });
    return payload;
  };


  if (containsMandatoryHandoffSignals(query)) {
    const emptyDls = computeDls(userContext, []);
    return finish(
      {
        answer: MANDATORY_HANDOFF_RESPONSE_HE,
        retrievedChunks: [],
        dls: emptyDls,
        latencyMs: Date.now() - startMs,
      },
      { safety: true }
    );
  }

  const fused = await querySimilarDocuments(query, userContext.permissionLevel, {
    limit: DEFAULT_RETRIEVAL_OVERFETCH,
    overfetch: DEFAULT_RETRIEVAL_OVERFETCH,
  });
  trace.retrievalSpan.end({
    chunkIds: fused.map((d) => d.id),
    fusedCount: fused.length,
  });

  const reranked = await reranker.rerank(query, toCandidates(fused), retrievalLimit);
  trace.rerankSpan.end({ chunkIds: reranked.map((d) => d.id) });

  const retrievedChunks = fromCandidates(reranked);
  
  const chunksForDls: KnowledgeChunk[] = reranked.map((d) => ({
    id: d.id,
    content: d.text,
    classificationLevel: d.classificationLevel,
  }));
  const dls = computeDls(userContext, chunksForDls);

  const contextBlock =
    reranked.length > 0
      ? reranked.map((d, i) => `[${i + 1}] ${d.text}`).join("\n\n")
      : "אין מידע ספציפי במסמכים לשאילתה זו. עליך להסתמך על הידע המקצועי הכללי שלך כאיש חינוך.";

  const adapter = getLlmAdapter();
  const conversationContext: LlmMessage[] = priorMessages
    .filter(isConversationMessage)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const roleName = userContext.roleName;
  const roleDescription = ROLE_DESCRIPTIONS[userContext.permissionLevel] || "";

  // Enhanced System Prompt focusing on structural line breaks and 200 words target length
  const llmMessages: LlmMessage[] = [
    {
      role: "system",
      content: [
`You are an expert mentor in the 'Adam LeAdam Ze Lev' project, assisting mentors with social dilemmas, boycott prevention, and violence reduction. 
The user is a ${roleName}. ${roleDescription}

Strict Guidelines:
****. Length Control: Keep the response concise to save tokens. The total length MUST NOT exceed 150 words.
1. Tone & Language: Respond ONLY in Hebrew. Maintain an empathetic, professional, and educational tone.
2. Privacy: NEVER identify real students, share names, or rank children.
3. Structure & Scannability: Break the text into 2 short paragraphs with line breaks. Use bullet points (•) or numbered lists for actionable steps.
`
      ].join("\n"),
    },
    ...conversationContext,
    {
      role: "user",
      content: `פנייה מקורית: ${query}\n\nהקשר שנאסף:\n${contextBlock}`,
    },
  ];

  const genTrace = trace.attachLlmGeneration(llmMessages);
  let answer = await adapter.generateText({
    messages: llmMessages,
    temperature: 0.3, 
  });
    
  genTrace.end({ answer });

  const result: BaselineRagResult = {
    answer,
    retrievedChunks,
    dls,
    latencyMs: Date.now() - startMs,
  };

  return finish(result);
}