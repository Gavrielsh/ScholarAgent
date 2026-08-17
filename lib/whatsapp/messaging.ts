import { fetchTextWithTimeout } from "@/lib/http/fetchWithTimeout";
import { logError, logWarn } from "@/lib/logger";

import {
  buildWhatsAppMessagesEndpoint,
  getWhatsAppConfig,
  WHATSAPP_HTTP_TIMEOUT_MS,
} from "@/lib/whatsapp/sendMessage";

const TYPING_REFRESH_MS = 20_000;
const TYPING_MAX_DURATION_MS = 120_000;

/**
 * Read receipts and typing indicators are pure UX and run on the critical path
 * before the RAG pipeline, so they get a much tighter budget than a real send.
 * Blocking a user's answer for 15s to draw a "typing…" bubble is a worse
 * outcome than not drawing it at all.
 */
const TYPING_HTTP_TIMEOUT_MS = Number(process.env.WHATSAPP_TYPING_TIMEOUT_MS ?? 5_000);

interface GraphSendResult {
  ok: boolean;
  status: number;
  body: string;
}

async function postToWhatsAppMessages(
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal | null } = {}
): Promise<GraphSendResult> {
  const config = getWhatsAppConfig();
  const endpoint = buildWhatsAppMessagesEndpoint(config);

  const response = await fetchTextWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    timeoutMs: options.timeoutMs ?? WHATSAPP_HTTP_TIMEOUT_MS,
    signal: options.signal,
    label: "GraphAPI/messages",
  });

  return { ok: response.ok, status: response.status, body: response.body };
}

/**
 * Marks the inbound message as read and switches the typing indicator on
 * (Meta keeps it visible for ~25s per call).
 *
 * NEVER THROWS. This runs on the worker's critical path purely for UX, so a Graph
 * API outage, expired token, or network error must not fail the job or block the
 * RAG pipeline. Returns whether Meta accepted the call, for callers that care.
 */
export async function markMessageReadAndTyping(
  messageId: string,
  signal?: AbortSignal | null
): Promise<boolean> {
  try {
    const result = await postToWhatsAppMessages(
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      { timeoutMs: TYPING_HTTP_TIMEOUT_MS, signal }
    );

    if (!result.ok) {
      logWarn("whatsapp_mark_read_typing_failed", result.body, {
        messageId,
        status: result.status,
      });
      return false;
    }

    return true;
  } catch (err) {
    // Covers fetch/DNS/TLS failures and a missing WhatsApp config.
    logError("whatsapp_mark_read_typing_error", err, { messageId });
    return false;
  }
}

export interface TypingSessionController {
  stop: () => void;
}

/**
 * Keeps an already-visible typing indicator alive during long RAG runs by
 * re-sending every 20s (Meta dismisses typing after ~25s or when a reply is sent).
 *
 * Deliberately does NOT send on start: the caller sends the first indicator via
 * markMessageReadAndTyping so the user sees it immediately, and firing here too
 * would double every message's Graph API traffic.
 */
export function startTypingKeepAlive(
  to: string,
  messageId: string | null
): TypingSessionController {
  if (!messageId) {
    return { stop: () => undefined };
  }

  let stopped = false;
  const startedAt = Date.now();

  const interval = setInterval(() => {
    if (stopped) return;
    if (Date.now() - startedAt > TYPING_MAX_DURATION_MS) return;
    void markMessageReadAndTyping(messageId).then((ok) => {
      if (!ok) logWarn("whatsapp_typing_refresh_failed", "Typing refresh rejected.", { to, messageId });
    });
  }, TYPING_REFRESH_MS);

  // Never let the indicator timer hold the Node process open on shutdown.
  interval.unref?.();

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
  signal?: AbortSignal | null;
}): Promise<void> {
  const result = await postToWhatsAppMessages(
    {
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
    },
    { signal: input.signal }
  );

  if (!result.ok) {
    throw new Error(`WhatsApp interactive send failed: HTTP ${result.status} ${result.body}`);
  }
}
