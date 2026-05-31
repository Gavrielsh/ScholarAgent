import { NextRequest, NextResponse } from "next/server";

import { runBaselineRag } from "@/lib/agent/baseline";
import type { ChatMessage } from "@/lib/agent/state";
import { appendChatEntries, readChatHistory } from "@/lib/chat/history";
import { buildBoundedConversationContext, truncateInboundMessage } from "@/lib/chat/context";
import { lookupUserByPhone, UserRegistryDbError } from "@/lib/auth/userRegistry";
import { logError, logInfo } from "@/lib/logger";
import { runAfterResponse } from "@/lib/server/postResponse";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/sendMessage";

export const runtime = "nodejs";

const UNAUTHORIZED_MESSAGE =
  "המספר אינו מזוהה במערכת. יש לפנות לאחד האחראים כדי להסדיר את הגישה.";
const FALLBACK_ERROR_MESSAGE =
  "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";

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

const processingMessageIds = new Set<string>();
const processedMessageIds = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

function pruneProcessedMessageCache(nowMs = Date.now()): void {
  for (const [messageId, expiresAt] of processedMessageIds.entries()) {
    if (expiresAt <= nowMs) {
      processedMessageIds.delete(messageId);
    }
  }
}

if (typeof setInterval !== "undefined") {
  setInterval(() => pruneProcessedMessageCache(), CACHE_PRUNE_INTERVAL_MS);
}

function beginMessageProcessing(messageId: string): boolean {
  const now = Date.now();
  if (processingMessageIds.has(messageId)) return false;
  if ((processedMessageIds.get(messageId) ?? 0) > now) return false;
  processingMessageIds.add(messageId);
  return true;
}

function markMessageProcessed(messageId: string): void {
  processingMessageIds.delete(messageId);
  processedMessageIds.set(messageId, Date.now() + IDEMPOTENCY_TTL_MS);
}

function abandonMessageProcessing(messageId: string): void {
  processingMessageIds.delete(messageId);
  processedMessageIds.delete(messageId);
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

  let userContext;
  try {
    userContext = await lookupUserByPhone(senderId);
  } catch (err) {
    if (err instanceof UserRegistryDbError) {
      logError("user_registry_db_error", err, { senderId });
      await sendWhatsAppTextMessage({
        to: senderId,
        body: "מצטערים, הייתה תקלה זמנית במערכת. אנא נסה שוב בעוד מספר דקות.",
      });
      return;
    }
    throw err;
  }
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

  let responseText = FALLBACK_ERROR_MESSAGE;
  try {
    const result = await runBaselineRag({
      query: messageBody,
      userContext,
      priorMessages,
    });
    responseText = result.answer;
    await sendWhatsAppTextMessage({ to: senderId, body: responseText });
  } catch (err) {
    logError("baseline_rag_or_whatsapp_send_failed", err, { senderId, messageId });
    try {
      await sendWhatsAppTextMessage({ to: senderId, body: FALLBACK_ERROR_MESSAGE });
    } catch (sendErr) {
      logError("whatsapp_fallback_send_failed", sendErr, { senderId, messageId });
    }
    throw err;
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

  if (event.messageId) {
    if (!beginMessageProcessing(event.messageId)) {
      logInfo("whatsapp_webhook_duplicate_ignored", "Duplicate message skipped by idempotency guard.", {
        messageId: event.messageId,
      });
      return NextResponse.json({ ok: true, status: "duplicate_ignored" }, { status: 200 });
    }
  }

  runAfterResponse(async () => {
    try {
      await processIncomingMessage(event);
      if (event.messageId) {
        markMessageProcessed(event.messageId);
      }
    } catch (err) {
      if (event.messageId) {
        abandonMessageProcessing(event.messageId);
      }
      logError("whatsapp_webhook_background_task_failed", err, {
        messageId: event.messageId ?? null,
        senderId: event.senderId,
      });
    }
  }).catch((err) => {
    if (event.messageId) {
      abandonMessageProcessing(event.messageId);
    }
    logError("whatsapp_webhook_background_schedule_failed", err, {
      messageId: event.messageId ?? null,
      senderId: event.senderId,
    });
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
