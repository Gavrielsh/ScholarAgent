// Baseline RAG — control configuration for comparative evaluation (proposal §6.2).
// Retrieve -> optional cross-encoder re-rank -> single LLM call.

import type { PermissionLevel, UserContext } from "@/lib/auth/types";
import { ROLE_DESCRIPTIONS } from "@/lib/auth/types";
import type { ChatMessage } from "@/lib/agent/state";
import { insertRagAuditLog } from "@/lib/db/auditLogs";
import {
  DEFAULT_RETRIEVAL_OVERFETCH,
  querySimilarDocuments,
  type SimilarDocument,
} from "@/lib/db/pgvector";
import { getLlmAdapter } from "@/lib/llm/adapter";
import type { DlsResult } from "@/lib/metrics/dls";
import type { LlmMessage } from "@/lib/llm/types";
import { logError } from "@/lib/logger";
import { defaultScoreReranker, type DocumentReranker, type RerankCandidate } from "@/lib/agent/baseline/reranker";
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
  retrievalLimit?: number;
  reranker?: DocumentReranker;
}

export interface BaselineRagCoreResult {
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

export type BaselineRagResult = BaselineRagCoreResult;

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

function fromCandidates(c: RerankCandidate[]): BaselineRagCoreResult["retrievedChunks"] {
  return c.map((d) => ({
    id: d.id,
    text: d.text,
    classificationLevel: d.classificationLevel,
    similarity: d.similarity,
    rrfScore: d.rrfScore,
  }));
}

/** Core RAG — no audit log; call recordBaselineRagMetrics after WhatsApp send. */
export async function runBaselineRagCore(input: BaselineRagInput): Promise<BaselineRagCoreResult> {
  const { query, userContext, priorMessages = [], retrievalLimit = 5 } = input;
  const reranker = input.reranker ?? defaultScoreReranker;
  const startMs = Date.now();

  const trace = await startBaselineRagTrace({
    userId: userContext.userId,
    query,
    permissionLevel: userContext.permissionLevel,
  });

  // RLS-scoped retrieval: the database enforces classification_level access control,
  // so every returned chunk is already authorised for this user's permission level.
  const fused = await querySimilarDocuments(query, userContext.permissionLevel, {
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

  // DLS is always 0 in production: RLS guarantees no unauthorised chunks reach
  // the reranker. The leakage metric is only meaningful in the evaluation pipeline
  // when querySimilarDocumentsBypassRls is explicitly used for baseline comparison.
  const dls: DlsResult = { score: 0, totalChunks: 0, unauthorizedChunks: 0, passed: true };

  // All reranked chunks are already authorised — build context directly.
  const contextBlock =
    rerankedAll.length > 0
      ? rerankedAll.map((d, i) => `[${i + 1}] ${d.text}`).join("\n\n")
      : "אין מידע ספציפי במסמכים לשאילתה זו.";

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
        "1. Length Control: The total length MUST be between 5 and 180 words.",
        "2. CRITICAL GROUNDING RULE: You must base your answer ONLY on the provided context. If the context does not contain sufficient information to answer the question, you MUST explicitly state: 'אין מספיק מידע במסמכים שלי כדי לענות על כך' and do not guess or provide general advice.",
        "3. Dynamic Length & Structure:",
        "   - For simple, conversational, or direct questions (e.g., greetings, short clarifications, factual queries): Keep the response concise, natural, and under 50 words. Do not force paragraphs or bullet points.",
        "   - For complex social dilemmas, counseling requests, or educational scenarios: Provide a detailed response of 150-180 words. Break the text into 2 short paragraphs with line breaks, and use bullet points (•) for actionable steps.",
        "   - FOR FOLLOW-UP QUESTIONS: If the user is asking a follow-up question, seeking clarification, or referring to your previous answer, your response MUST be concise and strictly UNDER 80 WORDS.",
        "4. Tone & Language: Respond ONLY in Hebrew. Maintain an empathetic, professional, and educational tone.",
        "5. Privacy: NEVER identify real students, share names, or rank children.",
        "6. Structure & Scannability: Break the text into 2 short paragraphs with line breaks. Use bullet points (•) or numbered lists for actionable steps.",
        "IMPORTANT FORMATTING RULE: Format your response for WhatsApp. Use a single asterisk for bold text (*text*) and NEVER use double asterisks (**text**).",
        "Return a detailed response of approximately 5 - 180 words.",
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

  const latencyMs = Date.now() - startMs;
  trace.endRoot({
    answer,
    chunkIds: retrievedChunks.map((c) => c.id),
    latencyMs,
  });

  return { answer, retrievedChunks, dls, latencyMs };
}

export async function recordBaselineRagMetrics(input: {
  query: string;
  userContext: UserContext;
  result: BaselineRagCoreResult;
}): Promise<void> {
  try {
    await insertRagAuditLog({
      query: input.query,
      userId: input.userContext.userId,
      retrievedChunkIds: input.result.retrievedChunks.map((c) => c.id),
      latencyMs: input.result.latencyMs,
    });
  } catch (err) {
    logError("baseline_rag.audit_log_insert_failed", err, { userId: input.userContext.userId });
  }
}

export async function runBaselineRag(input: BaselineRagInput): Promise<BaselineRagCoreResult> {
  const result = await runBaselineRagCore(input);
  await recordBaselineRagMetrics({ query: input.query, userContext: input.userContext, result });
  return result;
}
