// Baseline RAG — control configuration for comparative evaluation (proposal §6.2).
// Retrieve -> optional cross-encoder re-rank -> single LLM call. No LangGraph planner loop.
import type { PermissionLevel, UserContext } from "@/lib/auth/types";
import { ROLE_DESCRIPTIONS } from "@/lib/auth/types";
import { filterAuthorizedChunks } from "@/lib/auth/rbac";
import type { ChatMessage } from "@/lib/agent/state";
import { insertRagAuditLog } from "@/lib/db/auditLogs";
import {
  DEFAULT_RETRIEVAL_OVERFETCH,
  querySimilarDocumentsBypassRls,
  type SimilarDocument,
} from "@/lib/db/pgvector";
import { getLlmAdapter } from "@/lib/llm/adapter";
import { computeDls, type DlsResult } from "@/lib/metrics/dls";
import type { KnowledgeChunk } from "@/lib/auth/types";
import type { LlmMessage } from "@/lib/llm/types";
import { logError } from "@/lib/logger";
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
    log?: { safety?: boolean }
  ): Promise<BaselineRagResult> => {
    if (log?.safety) {
      logError("baseline_rag.safety_handoff", new Error("mandatory safety handoff"), {
        userId: userContext.userId,
      });
    }
    try {
      await insertRagAuditLog({
        query,
        userId: userContext.userId,
        retrievedChunkIds: payload.retrievedChunks.map((c) => c.id),
        latencyMs: Date.now() - startMs,
      });
    } catch (err) {
      logError("baseline_rag.audit_log_insert_failed", err, { userId: userContext.userId });
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

  // DLS experiment: unrestricted retrieval (service-role bypasses RLS) before RBAC filtering.
  const fused = await querySimilarDocumentsBypassRls(query, {
    limit: DEFAULT_RETRIEVAL_OVERFETCH,
    overfetch: DEFAULT_RETRIEVAL_OVERFETCH,
  });
  trace.retrievalSpan.end({
    chunkIds: fused.map((d) => d.id),
    fusedCount: fused.length,
  });
  const rerankedAll = await reranker.rerank(query, toCandidates(fused), retrievalLimit);
  trace.rerankSpan.end({ chunkIds: rerankedAll.map((d) => d.id) });

  const retrievedChunks = fromCandidates(rerankedAll);
  const chunksForDls: KnowledgeChunk[] = rerankedAll.map((d) => ({
    id: d.id,
    content: d.text,
    classificationLevel: d.classificationLevel,
  }));
  const dls = computeDls(userContext, chunksForDls);

  const authorizedChunks = filterAuthorizedChunks(userContext, chunksForDls);
  const contextBlock =
    authorizedChunks.length > 0
      ? authorizedChunks.map((d, i) => `[${i + 1}] ${d.content}`).join("\n\n")
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

  const llmMessages: LlmMessage[] = [
    {
      role: "system",
      content: [
        `You are an expert mentor in the 'Adam LeAdam Ze Lev' project, assisting mentors with social dilemmas, boycott prevention, and violence reduction.`,
        `The user is a ${roleName}. ${roleDescription}`,
        "",
        "Strict Guidelines:",
        "1. Length Control: The total length MUST be between 150 and 215 words.",
        "2. Tone & Language: Respond ONLY in Hebrew. Maintain an empathetic, professional, and educational tone.",
        "3. Privacy: NEVER identify real students, share names, or rank children.",
        "4. Structure & Scannability: Break the text into 2 short paragraphs with line breaks. Use bullet points (•) or numbered lists for actionable steps.",
        "IMPORTANT FORMATTING RULE: Format your response for WhatsApp. Use a single asterisk for bold text (*text*) and NEVER use double asterisks (**text**). Return a detailed response of approximately 215 words.",
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
  answer = answer.replace(/\*\*/g, "*");
  genTrace.end({ answer });

  const result: BaselineRagResult = {
    answer,
    retrievedChunks,
    dls,
    latencyMs: Date.now() - startMs,
  };

  return finish(result);
}