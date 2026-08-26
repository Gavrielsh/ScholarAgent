/**
 * Telemetry: distributed tracing and evaluation metrics.
 *
 * Deliberately separate from `lib/core/logger.ts`. Logging is a ubiquitous
 * primitive — every layer imports it to emit a line — whereas everything here
 * is measurement instrumentation with a handful of callers. Merging the two
 * would put the RAGAS judge and the Langfuse wrapper into the module graph of
 * every file that merely wants `logError`, and with no `"sideEffects": false`
 * in package.json the bundler cannot shake them back out.
 */

import type { AccessLevel } from "@/lib/core/db/accessLevel";

// ---------------------------------------------------------------------------
// Tracing (Langfuse)
// ---------------------------------------------------------------------------

/**
 * A chat message as tracing needs to see it: a role and its content.
 *
 * Deliberately looser than the chat domain's message model (whose role is a
 * string union) so that tracing records what it is given without core
 * depending on the domain. The domain's message arrays satisfy this shape.
 */
export interface TraceMessage {
  role: string;
  content: string;
}

export interface BaselineTraceHandles {
  endRoot: (output: { answer: string; chunkIds: string[]; latencyMs: number }) => void;
  retrievalSpan: {
    end: (output: { chunkIds: string[]; fusedCount: number }) => void;
  };
  /** Call after the final `messages` array for the baseline LLM is assembled. */
  attachLlmGeneration: (messages: readonly TraceMessage[]) => {
    end: (output: { answer: string }) => void;
  };
}

function noopTrace(): BaselineTraceHandles {
  const noop = { end: () => {} };
  const noopGen = { end: () => {} };
  return {
    endRoot: () => {},
    retrievalSpan: noop,
    attachLlmGeneration: () => noopGen,
  };
}

interface LangfuseObservation {
  end?: (data?: { output?: unknown }) => void;
}

interface LangfuseTrace {
  span: (args: { name: string; input?: unknown }) => LangfuseObservation;
  generation: (args: { name: string; model?: string; input?: unknown }) => LangfuseObservation;
  update?: (data: { output?: unknown }) => void;
}

interface LangfuseClient {
  trace: (args: {
    name: string;
    userId?: string;
    input?: unknown;
    metadata?: unknown;
  }) => LangfuseTrace;
  flushAsync?: () => Promise<unknown>;
}

/**
 * Optional Langfuse tracing. Set LANGFUSE_SECRET_KEY (+ LANGFUSE_PUBLIC_KEY for cloud).
 * Traces retrieval, the exact LLM message list, and the model answer.
 */
export async function startBaselineRagTrace(args: {
  userId: string;
  query: string;
  permissionLevel: number;
}): Promise<BaselineTraceHandles> {
  if (!process.env.LANGFUSE_SECRET_KEY) {
    return noopTrace();
  }

  try {
    const { Langfuse } = await import("langfuse");
    const client = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_HOST,
    }) as unknown as LangfuseClient;

    const root = client.trace({
      name: "baseline-rag",
      userId: args.userId,
      input: { query: args.query },
      metadata: { permissionLevel: args.permissionLevel },
    });

    const retrieval = root.span({ name: "retrieval", input: { query: args.query } });

    return {
      endRoot: (output: { answer: string; chunkIds: string[]; latencyMs: number }) => {
        if (typeof root.update === "function") {
          root.update({ output });
        }
        void client.flushAsync?.().catch((err: unknown) => console.error("Langfuse flush failed:", err));
      },
      retrievalSpan: {
        end: (output) => {
          if (typeof retrieval.end === "function") retrieval.end({ output });
        },
      },
      attachLlmGeneration: (messages: readonly TraceMessage[]) => {
        const generation = root.generation({
          name: "baseline-llm",
          model: process.env.LLM_PROVIDER ?? "mock",
          input: messages,
        });
        return {
          end: (output: { answer: string }) => {
            if (typeof generation.end === "function") generation.end({ output });
          },
        };
      },
    };
  } catch (err) {
    console.warn("Langfuse tracing disabled:", err);
    return noopTrace();
  }
}

// ---------------------------------------------------------------------------
// Data Leakage Score (DLS)
// ---------------------------------------------------------------------------

/**
 * The minimum shape DLS needs from a caller's user context.
 *
 * Structural on purpose: the security layer's `UserContext` satisfies it
 * without core having to import — or know about — the role model around it.
 */
export interface DlsSubject {
  permissionLevel: AccessLevel;
}

/** The minimum shape DLS needs from a retrieved chunk. */
export interface DlsClassifiedChunk {
  classificationLevel: AccessLevel;
}

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
export function computeDls(
  user: DlsSubject,
  retrievedChunks: readonly DlsClassifiedChunk[]
): DlsResult {
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

// ---------------------------------------------------------------------------
// RAGAS evaluation
// ---------------------------------------------------------------------------

// RAGAS-style evaluation — baseline metrics for comparative testing (thesis §8).
// Uses an LLM-as-judge when LLM_PROVIDER is configured; otherwise heuristic fallbacks.

/** The one message shape the judge prompt is built from. */
export interface RagasJudgeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The single LLM capability RAGAS needs. The chat domain's adapter satisfies it. */
export interface RagasJudge {
  generateText(input: {
    messages: RagasJudgeMessage[];
    temperature?: number;
    responseSchema?: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Resolves the judge only when one is actually needed.
 *
 * Injected rather than imported so this module stays free of provider wiring;
 * a factory rather than an instance so the heuristic path never constructs an
 * adapter it will not call.
 */
export type RagasJudgeFactory = () => RagasJudge;

export interface RagasInput {
  question: string;
  answer: string;
  contexts: string[];
  groundTruth?: string;
}

export interface RagasScores {
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  answerRelevancy: number;
  latencyMs?: number;
  executionCostUsd?: number;
}

/** Single labelled example in a golden dataset (offline eval). */
export interface GoldenDatasetRecord {
  id: string;
  question: string;
  /** Authoritative reference answer for recall-oriented checks. */
  groundTruthAnswer: string;
  /** Optional: substring hints expected to appear in retrieved contexts. */
  expectedContextHints?: string[];
}

function parseJudgeJson(raw: string): Partial<RagasScores> | null {
  const trimmed = raw.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    return JSON.parse(jsonText) as Partial<RagasScores>;
  } catch {
    return null;
  }
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Lexical fallbacks when no judge LLM is available (conservative lower bounds). */
function heuristicScores(input: RagasInput): RagasScores {
  const ans = input.answer.trim();
  const ctx = input.contexts;
  const gt = (input.groundTruth ?? "").trim();

  const contextPrecision =
    ctx.length === 0 ? 0 : ctx.filter((c) => c && c.trim().length > 40).length / ctx.length;

  const faithfulness =
    ctx.length === 0
      ? 0.15
      : ctx.some(
          (c) => ans.length > 20 && c.toLowerCase().includes(ans.slice(0, Math.min(40, ans.length)).toLowerCase())
        )
        ? 0.55
        : 0.3;

  const words = gt ? gt.split(/\s+/).filter((w) => w.length > 4) : [];
  const answerRelevancy =
    words.length === 0 ? (ans.length > 12 ? 0.4 : 0.15) : words.filter((w) => ans.toLowerCase().includes(w.toLowerCase())).length / words.length;

  const contextRecall =
    words.length === 0
      ? 0.5
      : words.filter((w) => ctx.some((c) => c.toLowerCase().includes(w.toLowerCase()))).length / words.length;

  return {
    contextPrecision: clamp01(contextPrecision),
    contextRecall: clamp01(contextRecall),
    faithfulness: clamp01(faithfulness),
    answerRelevancy: clamp01(answerRelevancy),
  };
}

/**
 * Scores a single RAG tuple. Prefer wiring a Python RAGAS worker in CI for publication-grade numbers;
 * this path provides repeatable baseline instrumentation inside the TypeScript repo.
 */
export async function evaluateRagas(
  input: RagasInput,
  judgeFactory: RagasJudgeFactory
): Promise<RagasScores> {
  const started = Date.now();
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  if (provider === "mock") {
    return { ...heuristicScores(input), latencyMs: Date.now() - started };
  }

  const adapter = judgeFactory();
  const contextBlock = input.contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");

  const judgePrompt = `You are an evaluation judge for a Hebrew educational RAG system.
Score each metric from 0 to 1 (float). Return ONLY JSON with keys:
contextPrecision (fraction of retrieved chunks that help answer the question),
contextRecall (how well contexts cover facts needed vs groundTruth, omit ground-truth checks if groundTruth empty — then use 0.5),
faithfulness (answer stays grounded in contexts, no contradictions),
answerRelevancy (answer addresses the question).

Question: ${input.question}
Answer: ${input.answer}
Contexts:
${contextBlock}
Ground truth (may be empty): ${input.groundTruth ?? ""}`;

  try {
    const raw = await adapter.generateText({
      temperature: 0,
      messages: [
        { role: "system", content: "Return compact JSON only. Keys: contextPrecision, contextRecall, faithfulness, answerRelevancy (numbers 0-1)." },
        { role: "user", content: judgePrompt },
      ],
      responseSchema: {
        type: "object",
        properties: {
          contextPrecision: { type: "number" },
          contextRecall: { type: "number" },
          faithfulness: { type: "number" },
          answerRelevancy: { type: "number" },
        },
        required: ["contextPrecision", "contextRecall", "faithfulness", "answerRelevancy"],
      },
    });

    const parsed = parseJudgeJson(raw);
    if (!parsed) {
      return { ...heuristicScores(input), latencyMs: Date.now() - started };
    }

    return {
      contextPrecision: clamp01(parsed.contextPrecision),
      contextRecall: clamp01(parsed.contextRecall),
      faithfulness: clamp01(parsed.faithfulness),
      answerRelevancy: clamp01(parsed.answerRelevancy),
      latencyMs: Date.now() - started,
    };
  } catch {
    return { ...heuristicScores(input), latencyMs: Date.now() - started };
  }
}
