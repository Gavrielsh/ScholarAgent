import type { ChatMessage } from "@/lib/agent/state";
import type { UserContext } from "@/lib/auth/types";
import { isElevatedRole, shouldSkipGuardrails } from "@/lib/auth/roles";
import { resolveAdminAnalyticsFollowUp } from "@/lib/agent/baseline/adminAnalyticsHandler";
import {
  resolveL0AdminFlow,
  resolveL1ChatHistoryFlow,
} from "@/lib/agent/baseline/chatHistoryHandlers";
import {
  matchesChatHistoryHeuristic,
  type BaselineIntent,
} from "@/lib/agent/baseline/intentRouter";
import {
  runBaselineRagCore,
  type BaselineRagCoreResult,
} from "@/lib/agent/baseline/index";
import {
  checkSafetySignals,
  MANDATORY_HANDOFF_RESPONSE_HE,
} from "@/lib/agent/baseline/safetySignals";
import { getL0AdminSession } from "@/lib/chat/l0AdminSession";

export type BaselineDeliveryKind = "text" | "interactive_sent" | "already_sent_prompt";

export interface BaselineProcessResult {
  kind: BaselineDeliveryKind;
  answer: string;
  ragMetrics: BaselineRagCoreResult | null;
  intent: BaselineIntent;
}

export interface BaselineProcessInput {
  /** WhatsApp E.164 sender id (phone). */
  senderPhone: string;
  query: string;
  userContext: UserContext;
  priorMessages?: ChatMessage[];
  buttonId?: string;
}

const EMPTY_DLS = { score: 0, totalChunks: 0, unauthorizedChunks: 0, passed: true } as const;

/** Outcome of the single synchronous pre-flight pass over the raw query. */
type LexicalVerdict =
  | { kind: "emergency"; response: string }
  | { kind: "chat_history" }
  | { kind: "rag" };

/**
 * Single O(n) lexical sweep run before any I/O.
 *
 * Safety and chat-history routing used to be two separate sequential passes, the
 * second of which could escalate to an LLM round-trip. Both are pure regex work,
 * so they collapse into one synchronous function that costs microseconds and adds
 * zero network latency to TTFT.
 */
function sweepQueryLexically(query: string, userContext: UserContext): LexicalVerdict {
  // Safety first: distress signals must never reach the LLM, and must be checked
  // before routing so no other branch can swallow the query.
  if (!shouldSkipGuardrails(userContext)) {
    const safety = checkSafetySignals(query);
    if (safety.isEmergency) {
      return {
        kind: "emergency",
        response: safety.response ?? MANDATORY_HANDOFF_RESPONSE_HE,
      };
    }
  }

  // Only L0/L1 may pull staff chat history.
  if (isElevatedRole(userContext.permissionLevel) && matchesChatHistoryHeuristic(query)) {
    return { kind: "chat_history" };
  }

  return { kind: "rag" };
}

export async function processBaselineQuery(
  input: BaselineProcessInput
): Promise<BaselineProcessResult> {
  const { query, userContext, priorMessages = [], buttonId, senderPhone } = input;

  // Task 2 (context-aware routing): checked before the lexical sweep / RAG
  // fallback so a follow-up question about a just-generated report never gets
  // treated as a generic RAG_INQUIRY. A button click or an in-progress L0 menu
  // selection (l0AdminSession) is an explicit fresh action, so only free text
  // outside those flows is eligible to be treated as an analytics follow-up.
  // resolveAdminAnalyticsFollowUp re-validates permissionLevel === 0 internally.
  if (userContext.permissionLevel === 0 && !buttonId && !getL0AdminSession(senderPhone)) {
    const analytics = await resolveAdminAnalyticsFollowUp({
      adminPhone: senderPhone,
      query,
      requesterPermissionLevel: userContext.permissionLevel,
    });
    if (analytics.handled) {
      return { kind: "text", answer: analytics.answer, ragMetrics: null, intent: "CHAT_HISTORY" };
    }
  }

  const sweep = sweepQueryLexically(query, userContext);

  if (sweep.kind === "emergency") {
    const safetyPayload: BaselineRagCoreResult = {
      answer: sweep.response,
      retrievedChunks: [],
      dls: { ...EMPTY_DLS },
      latencyMs: 0,
    };
    return {
      kind: "text",
      answer: sweep.response,
      ragMetrics: safetyPayload,
      intent: "RAG_INQUIRY",
    };
  }

  // An interactive button reply is always a chat-history menu selection.
  const intent: BaselineIntent =
    buttonId || sweep.kind === "chat_history" ? "CHAT_HISTORY" : "RAG_INQUIRY";

  if (userContext.permissionLevel === 0) {
    const l0 = await resolveL0AdminFlow({
      adminPhone: senderPhone,
      query,
      buttonId,
      isChatHistoryIntent: intent === "CHAT_HISTORY",
      // Trusted, DB-resolved level (never from buttonId/query) — see the guard at
      // the top of resolveL0AdminFlow.
      requesterPermissionLevel: userContext.permissionLevel,
    });

    if (l0.type === "interactive_sent") {
      return { kind: "interactive_sent", answer: "", ragMetrics: null, intent };
    }
    if (l0.type === "prompt_sent") {
      return { kind: "already_sent_prompt", answer: l0.promptText, ragMetrics: null, intent };
    }
    if (l0.type === "text" && l0.answer) {
      return { kind: "text", answer: l0.answer, ragMetrics: null, intent };
    }
    // L0 non–chat-history queries fall through to standard RAG below.
  }

  if (userContext.permissionLevel === 1 && intent === "CHAT_HISTORY") {
    const answer = await resolveL1ChatHistoryFlow(userContext.permissionLevel);
    return { kind: "text", answer, ragMetrics: null, intent };
  }

  // Greetings and small talk are handled by the system directives inside the main
  // generation call, so no separate classification hop is needed here.
  const rag = await runBaselineRagCore({
    query,
    userContext,
    priorMessages,
  });

  return {
    kind: "text",
    answer: rag.answer,
    ragMetrics: rag,
    intent: "RAG_INQUIRY",
  };
}
