import { NextRequest, NextResponse } from "next/server";

import { recordBaselineRagMetrics } from "@/lib/agent/baseline";
import { processBaselineQuery } from "@/lib/agent/baseline/orchestrator";
import type { ChatMessage } from "@/lib/agent/state";
import { appendChatEntries, readChatHistory } from "@/lib/chat/history";
import { buildBoundedConversationContext, truncateInboundMessage } from "@/lib/chat/context";
import { lookupUserByPhone, UserRegistryDbError } from "@/lib/auth/userRegistry";
import { logError, logInfo } from "@/lib/logger";
import { runAfterResponse } from "@/lib/server/postResponse";
import {
  markMessageReadAndTyping,
  startTypingSession,
} from "@/lib/whatsapp/messaging";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/sendMessage";

export const runtime = "nodejs";

const UNAUTHORIZED_MESSAGE =
  "המספר אינו מזוהה במערכת. יש לפנות לאחד האחראים כדי להסדיר את הגישה.";
const FALLBACK_ERROR_MESSAGE =
  "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";

interface WhatsAppTextBody {
  body?: string;
}

interface WhatsAppInteractiveReply {
  type?: string;
  button_reply?: { id?: string; title?: string };
}

interface WhatsAppMessageEvent {
  from: string;
  id: string;
  type?: string;
  text?: WhatsAppTextBody;
  interactive?: WhatsAppInteractiveReply;
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messaging_product?: string;
        statuses?: Array<{ id: string; status: string }>;
        messages?: WhatsAppMessageEvent[];
      };
    }>;
  }>;
}

interface ParsedInboundEvent {
  senderId: string;
  messageBody: string;
  messageId: string | null;
  buttonId?: string;
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

function isStatusOnlyWebhook(payload: WhatsAppWebhookPayload): boolean {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value?.statuses?.length) return false;
  return !value.messages?.length;
}

function parseInboundEvent(payload: WhatsAppWebhookPayload): ParsedInboundEvent | null {
  const firstMessage = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!firstMessage?.from) return null;

  const senderId = firstMessage.from;
  const messageId = firstMessage.id ?? null;

  if (firstMessage.type === "interactive" || firstMessage.interactive?.button_reply) {
    const buttonId = firstMessage.interactive?.button_reply?.id;
    const title = firstMessage.interactive?.button_reply?.title ?? "";
    if (!buttonId) return null;
    return {
      senderId,
      messageId,
      messageBody: title,
      buttonId,
    };
  }

  const isText = firstMessage.type === "text" || !!firstMessage.text?.body;
  if (!isText) return null;

  const messageBody = firstMessage.text?.body;
  if (!messageBody) return null;

  return { senderId, messageBody, messageId };
}

async function persistInboundMessage(
  senderId: string,
  messageBody: string,
  messageId: string | null
): Promise<void> {
  try {
    await appendChatEntries(senderId, [
      {
        role: "user",
        content: messageBody,
        timestamp: new Date().toISOString(),
        messageId: messageId ?? undefined,
      },
    ]);
  } catch (err) {
    logError("chat_history_inbound_persist_failed", err, { senderId });
  }
}

async function persistOutboundMessage(senderId: string, content: string): Promise<void> {
  try {
    await appendChatEntries(senderId, [
      { role: "assistant", content, timestamp: new Date().toISOString() },
    ]);
  } catch (err) {
    logError("chat_history_outbound_persist_failed", err, { senderId });
  }
}

async function processIncomingMessage(event: ParsedInboundEvent): Promise<void> {
  const { senderId, messageId } = event;
  const messageBody = truncateInboundMessage(event.messageBody);

  if (messageId) {
    void markMessageReadAndTyping(messageId).catch((err) => {
      logError("whatsapp_initial_typing_failed", err, { senderId, messageId });
    });
  }

  const typingSession = startTypingSession(senderId, messageId);

  try {
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

    await persistInboundMessage(senderId, messageBody, messageId);

    let priorMessages: ChatMessage[] = [];
    try {
      const history = await readChatHistory(senderId);
      const withoutLast = history.entries.slice(0, -1);
      priorMessages = buildBoundedConversationContext(withoutLast);
    } catch (err) {
      logError("chat_history_context_load_failed", err, { senderId });
    }

    let processResult;
    try {
      processResult = await processBaselineQuery({
        senderPhone: senderId,
        query: messageBody,
        userContext,
        priorMessages,
        buttonId: event.buttonId,
      });
    } catch (err) {
      logError("baseline_process_failed", err, { senderId, messageId });
      await sendWhatsAppTextMessage({ to: senderId, body: FALLBACK_ERROR_MESSAGE });
      throw err;
    }

    if (processResult.kind === "interactive_sent") {
      return;
    }

    const outbound =
      processResult.kind === "already_sent_prompt"
        ? processResult.answer
        : processResult.answer || FALLBACK_ERROR_MESSAGE;

    if (outbound) {
      try {
        await sendWhatsAppTextMessage({ to: senderId, body: outbound });
      } catch (err) {
        logError("whatsapp_reply_send_failed", err, { senderId, messageId });
        throw err;
      }

      if (processResult.ragMetrics) {
        try {
          await recordBaselineRagMetrics({
            query: messageBody,
            userContext,
            result: processResult.ragMetrics,
          });
        } catch (err) {
          logError("baseline_post_send_metrics_failed", err, { senderId });
        }
      }

      await persistOutboundMessage(senderId, outbound);
    }
  } finally {
    typingSession.stop();
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

  if (isStatusOnlyWebhook(body)) {
    return NextResponse.json({ ok: true, ignored: "status_update" }, { status: 200 });
  }

  const event = parseInboundEvent(body);
  if (!event) {
    return NextResponse.json({ ok: true, ignored: "לא נמצאה הודעה נתמכת במטען." }, { status: 200 });
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
