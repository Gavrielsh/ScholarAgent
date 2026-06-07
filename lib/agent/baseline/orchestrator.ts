import type { ChatMessage } from "@/lib/agent/state";
import type { UserContext } from "@/lib/auth/types";
import { shouldSkipGuardrails } from "@/lib/auth/roles";
import {
  resolveL0AdminFlow,
  resolveL1ChatHistoryFlow,
} from "@/lib/agent/baseline/chatHistoryHandlers";
import { classifyBaselineIntent, type BaselineIntent } from "@/lib/agent/baseline/intentRouter";
import {
  runBaselineRagCore,
  type BaselineRagCoreResult,
} from "@/lib/agent/baseline/index";
import {
  checkSafetySignals,
  MANDATORY_HANDOFF_RESPONSE_HE,
} from "@/lib/agent/baseline/safetySignals";

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

export async function processBaselineQuery(
  input: BaselineProcessInput
): Promise<BaselineProcessResult> {
  const { query, userContext, priorMessages = [], buttonId, senderPhone } = input;
  const skipGuardrails = shouldSkipGuardrails(userContext);

  // Emergency short-circuit: evaluated BEFORE intent routing and RAG.
  // If the message contains distress signals, we NEVER let the LLM handle it.
  if (!skipGuardrails) {
    const safety = checkSafetySignals(query);
    if (safety.isEmergency) {
      const emergencyResponse = safety.response ?? MANDATORY_HANDOFF_RESPONSE_HE;
      const safetyPayload: BaselineRagCoreResult = {
        answer: emergencyResponse,
        retrievedChunks: [],
        dls: { score: 0, totalChunks: 0, unauthorizedChunks: 0, passed: true },
        latencyMs: 0,
      };
      return {
        kind: "text",
        answer: emergencyResponse,
        ragMetrics: safetyPayload,
        intent: "RAG_INQUIRY",
      };
    }
  }

  const intent = buttonId
    ? "CHAT_HISTORY"
    : await classifyBaselineIntent(query, userContext);

  if (userContext.permissionLevel === 0) {
    const l0 = await resolveL0AdminFlow({
      adminPhone: senderPhone,
      query,
      buttonId,
      isChatHistoryIntent: intent === "CHAT_HISTORY",
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
    const answer = await resolveL1ChatHistoryFlow();
    return { kind: "text", answer, ragMetrics: null, intent };
  }

  if (intent === "CHIT_CHAT") {
    return {
      kind: "text",
      answer:
        "שלום! אני הבוט המנטורי של מיזם 'אדם לאדם'. אשמח לסייע לך בשאלות פדגוגיות, התמודדות עם קונפליקטים, תכנון פעילויות ולוגיסטיקה של הצהרון.",
      ragMetrics: null,
      intent,
    };
  }

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
