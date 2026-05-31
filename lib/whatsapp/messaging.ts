import { logError, logWarn } from "@/lib/logger";

import { getWhatsAppConfig } from "@/lib/whatsapp/sendMessage";

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v20.0";
const TYPING_REFRESH_MS = 20_000;
const TYPING_MAX_DURATION_MS = 120_000;

interface GraphSendResult {
  ok: boolean;
  status: number;
  body: string;
}

async function postToWhatsAppMessages(payload: Record<string, unknown>): Promise<GraphSendResult> {
  const { accessToken, phoneNumberId } = getWhatsAppConfig();
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

/** Marks inbound message as read and shows the typing indicator (max ~25s per call). */
export async function markMessageReadAndTyping(messageId: string): Promise<void> {
  const result = await postToWhatsAppMessages({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });

  if (!result.ok) {
    logWarn("whatsapp_mark_read_typing_failed", result.body, {
      messageId,
      status: result.status,
    });
  }
}

export interface TypingSessionController {
  stop: () => void;
}

/**
 * Keeps the typing indicator active during long RAG runs by re-sending every 20s
 * (Meta dismisses typing after ~25s or when a reply is sent).
 */
export function startTypingSession(
  to: string,
  messageId: string | null
): TypingSessionController {
  if (!messageId) {
    return { stop: () => undefined };
  }

  let stopped = false;
  const startedAt = Date.now();

  const refresh = (): void => {
    if (stopped) return;
    if (Date.now() - startedAt > TYPING_MAX_DURATION_MS) return;
    void markMessageReadAndTyping(messageId).catch((err) => {
      logError("whatsapp_typing_refresh_failed", err, { to, messageId });
    });
  };

  refresh();
  const interval = setInterval(refresh, TYPING_REFRESH_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export interface InteractiveButton {
  id: string;
  title: string;
}

export async function sendWhatsAppInteractiveButtons(input: {
  to: string;
  bodyText: string;
  buttons: InteractiveButton[];
}): Promise<void> {
  const result = await postToWhatsAppMessages({
    messaging_product: "whatsapp",
    to: input.to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: input.bodyText },
      action: {
        buttons: input.buttons.map((button) => ({
          type: "reply",
          reply: { id: button.id, title: button.title },
        })),
      },
    },
  });

  if (!result.ok) {
    throw new Error(`WhatsApp interactive send failed: HTTP ${result.status} ${result.body}`);
  }
}
