import { NextRequest, NextResponse } from "next/server";

import { runBaselineRag } from "@/lib/agent/baseline";
import { runAgentWorkflow } from "@/lib/agent/graph";
import type { ChatMessage } from "@/lib/agent/state";
import { appendChatEntries, readChatHistory } from "@/lib/chat/history";
import { buildBoundedConversationContext, truncateInboundMessage } from "@/lib/chat/context";
import { lookupUserByPhone } from "@/lib/auth/userRegistry";
import { logError } from "@/lib/logger";
import { runAfterResponse } from "@/lib/server/postResponse";
import { evaluatePromptInjection } from "@/lib/security/promptInjection";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/sendMessage";

export const runtime = "nodejs";

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

async function processIncomingMessage(event: ParsedTextEvent): Promise<void> {
  const { senderId, messageId } = event;
  const messageBody = truncateInboundMessage(event.messageBody);
  const receivedAt = new Date().toISOString();

  if (RAG_MODE === "agentic") {
    try {
      const isPromptInjection = await evaluatePromptInjection(messageBody);
      if (isPromptInjection) {
        logError("prompt_injection_blocked", new Error("injection_detected"), { senderId });
        await sendWhatsAppTextMessage({ to: senderId, body: PROMPT_INJECTION_SAFETY_MESSAGE });
        return;
      }
    } catch (err) {
      logError("prompt_injection_check_failed", err, { senderId });
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
      {
        role: "user",
        content: messageBody,
        timestamp: receivedAt,
        messageId: messageId ?? undefined,
      },
    ]);
  } catch (err) {
    logError("chat_history_inbound_persist_failed", err, { senderId });
  }

  let priorMessages: ChatMessage[] = [];
  try {
    const history = await readChatHistory(senderId);
    const withoutLast = history.entries.slice(0, -1);
    priorMessages = buildBoundedConversationContext(withoutLast);
  } catch (err) {
    logError("chat_history_context_load_failed", err, { senderId });
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
    logError("rag_workflow_failed", err, { senderId, ragMode: RAG_MODE });
    responseText = "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";
  }

  try {
    await sendWhatsAppTextMessage({ to: senderId, body: responseText });
  } catch (err) {
    logError("whatsapp_reply_send_failed", err, { senderId });
  }

  try {
    await appendChatEntries(senderId, [
      { role: "assistant", content: responseText, timestamp: new Date().toISOString() },
    ]);
  } catch (err) {
    logError("chat_history_outbound_persist_failed", err, { senderId });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "אימות ה-Webhook נכשל." }, { status: 403 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  await runAfterResponse(() => processIncomingMessage(event));

  return NextResponse.json({ ok: true }, { status: 200 });
}
