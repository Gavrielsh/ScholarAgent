import { recordBaselineRagMetrics } from "@/lib/agent/baseline";
import { processBaselineQuery } from "@/lib/agent/baseline/orchestrator";
import type { ChatMessage } from "@/lib/agent/state";
import { appendChatEntries, readChatHistory } from "@/lib/chat/history";
import { buildBoundedConversationContext, truncateInboundMessage } from "@/lib/chat/context";
import { lookupUserByPhone, UserRegistryDbError } from "@/lib/auth/userRegistry";
import { logError } from "@/lib/logger";
import {
  markMessageReadAndTyping,
  startTypingSession,
} from "@/lib/whatsapp/messaging";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/sendMessage";
import type { ParsedInboundEvent } from "@/lib/whatsapp/types";

const UNAUTHORIZED_MESSAGE =
  "המספר אינו מזוהה במערכת. יש לפנות לאחד האחראים כדי להסדיר את הגישה.";
const FALLBACK_ERROR_MESSAGE =
  "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";

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

export async function processIncomingMessage(event: ParsedInboundEvent): Promise<void> {
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
