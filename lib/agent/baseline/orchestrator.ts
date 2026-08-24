import type { ChatMessage } from "@/lib/agent/state";
import type { UserContext } from "@/lib/auth/types";
import { isAdminRole, isElevatedRole, isManagerRole } from "@/lib/auth/roles";
import { resolveAdminAnalyticsFollowUp } from "@/lib/agent/baseline/adminAnalyticsHandler";
import {
  resolveL0AdminFlow,
  runL1DailyStaffSummary,
} from "@/lib/agent/baseline/chatHistoryHandlers";
import {
  matchesChatHistoryHeuristic,
  type BaselineIntent,
} from "@/lib/agent/baseline/intentRouter";
import {
  runBaselineRagCore,
  type BaselineRagCoreResult,
} from "@/lib/agent/baseline/ragCore";
import {
  containsMandatoryHandoffSignals,
  MANDATORY_HANDOFF_RESPONSE_HE,
} from "@/lib/agent/baseline/safetySignals";
import { getL0AdminSession } from "@/lib/chat/l0AdminSession";
import { logError } from "@/lib/logger";

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
  /**
   * Already redacted and safety-screened by
   * lib/whatsapp/incomingMessageProcessor.ts. Never raw webhook text.
   */
  query: string;
  userContext: UserContext;
  priorMessages?: ChatMessage[];
  buttonId?: string;
  /** Job deadline / shutdown cancellation, forwarded to every LLM call. */
  signal?: AbortSignal | null;
}

const EMPTY_DLS = { score: 0, totalChunks: 0, unauthorizedChunks: 0, passed: true } as const;

/** Outcome of the single synchronous pre-flight pass over the query. */
type LexicalVerdict = { kind: "chat_history" } | { kind: "rag" };

/**
 * Single O(n) lexical sweep run before any I/O.
 *
 * Safety screening no longer lives here — it moved upstream to
 * `evaluateInboundSafety`, which runs before the first database write so that
 * nothing is persisted or traced ahead of the distress check. What remains is
 * pure routing, kept synchronous and LLM-free so it adds nothing to TTFT.
 */
function sweepQueryLexically(query: string, userContext: UserContext): LexicalVerdict {
  // Only L0/L1 may pull staff chat history.
  if (isElevatedRole(userContext.permissionLevel) && matchesChatHistoryHeuristic(query)) {
    return { kind: "chat_history" };
  }

  return { kind: "rag" };
}

export async function processBaselineQuery(
  input: BaselineProcessInput
): Promise<BaselineProcessResult> {
  const { query, userContext, priorMessages = [], buttonId, senderPhone, signal } = input;

  // Defence in depth. The processor is the designated safety gate, but this
  // function is also reachable from scripts/evaluate_runner.ts and any future
  // caller. If distress text ever arrives here it means the gate was bypassed —
  // fail closed with the handoff and log loudly rather than calling an LLM.
  if (containsMandatoryHandoffSignals(query)) {
    logError(
      "safety_gate_bypassed",
      new Error("Distress signals reached the orchestrator"),
      { senderPhone, permissionLevel: userContext.permissionLevel }
    );
    return {
      kind: "text",
      answer: MANDATORY_HANDOFF_RESPONSE_HE,
      ragMetrics: {
        answer: MANDATORY_HANDOFF_RESPONSE_HE,
        retrievedChunks: [],
        dls: { ...EMPTY_DLS },
        latencyMs: 0,
      },
      intent: "RAG_INQUIRY",
    };
  }

  // Task 2 (context-aware routing): checked before the lexical sweep / RAG
  // fallback so a follow-up question about a just-generated report never gets
  // treated as a generic RAG_INQUIRY. A button click or an in-progress L0 menu
  // selection (l0AdminSession) is an explicit fresh action, so only free text
  // outside those flows is eligible to be treated as an analytics follow-up.
  // resolveAdminAnalyticsFollowUp re-validates the admin role internally.
  if (isAdminRole(userContext.permissionLevel) && !buttonId && !(await getL0AdminSession(senderPhone))) {
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

  // An interactive button reply is always a chat-history menu selection.
  const intent: BaselineIntent =
    buttonId || sweep.kind === "chat_history" ? "CHAT_HISTORY" : "RAG_INQUIRY";

  if (isAdminRole(userContext.permissionLevel)) {
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

  if (isManagerRole(userContext.permissionLevel) && intent === "CHAT_HISTORY") {
    const answer = await runL1DailyStaffSummary(userContext.permissionLevel);
    return { kind: "text", answer, ragMetrics: null, intent };
  }

  // Greetings and small talk are handled by the system directives inside the main
  // generation call, so no separate classification hop is needed here.
  const rag = await runBaselineRagCore({
    query,
    userContext,
    priorMessages,
    signal,
  });

  return {
    kind: "text",
    answer: rag.answer,
    ragMetrics: rag,
    intent: "RAG_INQUIRY",
  };
}
