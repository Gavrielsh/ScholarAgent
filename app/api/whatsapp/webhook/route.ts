import { NextRequest, NextResponse } from "next/server";

import { runBaselineRag } from "@/lib/agent/baseline";
import { runAgentWorkflow } from "@/lib/agent/graph";
import { appendChatEntries, readChatHistory } from "@/lib/chat/history";
import { lookupUserByPhone } from "@/lib/auth/userRegistry";
import { evaluatePromptInjection } from "@/lib/security/promptInjection";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/sendMessage";
import type { ChatMessage } from "@/lib/agent/state";

// Maximum number of prior turns to include as conversation context.
// Keeps the LLM prompt bounded while preserving meaningful history.
const MAX_HISTORY_TURNS = 10;
const RAG_MODE = (process.env.RAG_MODE ?? "baseline").toLowerCase();
const PROMPT_INJECTION_SAFETY_MESSAGE =
  "לא ניתן לעבד את ההודעה הזו מטעמי בטיחות. אפשר לנסח מחדש את הבקשה ללא הוראות לשינוי התנהגות המערכת.";
const UNAUTHORIZED_MESSAGE =
  "המספר אינו מזוהה במערכת. יש לפנות לאחד האחראים כדי להסדיר את הגישה.";

interface WhatsAppTextMessageEvent {
  from: string;
  id: string;
  text?: { body: string };
  type?: string;
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppTextMessageEvent[];
      };
    }>;
  }>;
}

interface ParsedTextEvent {
  senderId: string;
  messageBody: string;
  messageId: string | null;
}

function parseIncomingTextEvent(payload: WhatsAppWebhookPayload): ParsedTextEvent | null {
  const firstMessage = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!firstMessage) return null;

  const isText = firstMessage.type === "text" || !!firstMessage.text?.body;
  if (!isText) return null;

  const senderId = firstMessage.from;
  const messageBody = firstMessage.text?.body;
  if (!senderId || !messageBody) return null;

  return { senderId, messageBody, messageId: firstMessage.id ?? null };
}

// Converts stored chat history entries into the ChatMessage format
// expected by the agent graph, capped to the most recent N turns.
function buildConversationContext(
  rawEntries: Array<{ role: string; content: string; timestamp: string }>
): ChatMessage[] {
  const recent = rawEntries.slice(-MAX_HISTORY_TURNS * 2); // each turn = 2 entries
  return recent
    .filter((e) => e.role === "user" || e.role === "assistant")
    .map((e) => ({
      role: e.role as "user" | "assistant",
      content: e.content,
      createdAt: e.timestamp,
    }));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const mode      = searchParams.get("hub.mode");
  const token     = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "אימות ה-Webhook נכשל." }, { status: 403 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 1 — Parse payload defensively. Return 200 so Meta doesn't retry.
  let body: WhatsAppWebhookPayload;
  try {
    body = (await request.json()) as WhatsAppWebhookPayload;
  } catch {
    return NextResponse.json({ ok: true, ignored: "מטען JSON לא תקין." }, { status: 200 });
  }

  const event = parseIncomingTextEvent(body);
  if (!event) {
    return NextResponse.json({ ok: true, ignored: "לא נמצאה הודעת טקסט נתמכת במטען." }, { status: 200 });
  }

  const { senderId, messageBody, messageId } = event;
  void (async () => {
    try {
      const receivedAt = new Date().toISOString();

      if (RAG_MODE === "agentic") {
        let isPromptInjection: boolean;
        try {
          isPromptInjection = await evaluatePromptInjection(messageBody);
        } catch (err) {
          console.error("Prompt injection check failed:", { senderId, err });
          await sendWhatsAppTextMessage({ to: senderId, body: PROMPT_INJECTION_SAFETY_MESSAGE });
          return;
        }

        if (isPromptInjection) {
          console.error("Blocked prompt injection attempt:", { senderId });
          await sendWhatsAppTextMessage({ to: senderId, body: PROMPT_INJECTION_SAFETY_MESSAGE });
          return;
        }
      }

      const userContext = await lookupUserByPhone(senderId);
      if (!userContext) {
        await sendWhatsAppTextMessage({ to: senderId, body: UNAUTHORIZED_MESSAGE });
        return;
      }

      try {
        await appendChatEntries(senderId, [
          { role: "user", content: messageBody, timestamp: receivedAt, messageId: messageId ?? undefined },
        ]);
      } catch (err) {
        console.error("Failed to persist inbound chat entry:", err);
      }

      let priorMessages: ChatMessage[] = [];
      try {
        const history = await readChatHistory(senderId);
        const withoutLast = history.entries.slice(0, -1);
        priorMessages = buildConversationContext(withoutLast);
      } catch (err) {
        console.error("Failed to load chat history for context:", err);
      }

      let responseText: string;
      try {
        if (RAG_MODE === "agentic") {
          const result = await runAgentWorkflow({
            senderId,
            mission: messageBody,
            incomingMessage: messageBody,
            userContext,
            priorMessages,
          });

          responseText = String(
            result.final_response ??
              "קיבלתי את ההודעה שלך, ואני צריך עוד רגע כדי לספק תשובה מלאה יותר."
          );
        } else {
          const result = await runBaselineRag({
            query: messageBody,
            userContext,
            priorMessages,
          });
          responseText = result.answer;
        }
      } catch (err) {
        console.error("RAG workflow error:", err);
        responseText = "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";
      }

      try {
        await sendWhatsAppTextMessage({ to: senderId, body: responseText });
      } catch (err) {
        console.error("Failed to send WhatsApp reply:", err);
      }

      try {
        await appendChatEntries(senderId, [
          { role: "assistant", content: responseText, timestamp: new Date().toISOString() },
        ]);
      } catch (err) {
        console.error("Failed to persist assistant chat entry:", err);
      }
    } catch (err) {
      console.error("Detached webhook processing failed:", err);
    }
  })().catch((err) => {
    console.error("Detached webhook unhandled rejection:", err);
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
