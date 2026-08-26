import { logError, logWarn } from "@/lib/logger";
import { postGraphMessages } from "@/lib/whatsapp/sendMessage";

const TYPING_REFRESH_MS = 20_000;
const TYPING_MAX_DURATION_MS = 120_000;

/**
 * Read receipts and typing indicators are pure UX and run on the critical path
 * before the RAG pipeline, so they get a much tighter budget than a real send.
 * Blocking a user's answer for 15s to draw a "typing…" bubble is a worse
 * outcome than not drawing it at all.
 */
const TYPING_HTTP_TIMEOUT_MS = Number(process.env.WHATSAPP_TYPING_TIMEOUT_MS ?? 5_000);

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
    const result = await postGraphMessages(
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      { timeoutMs: TYPING_HTTP_TIMEOUT_MS, signal, retries: false }
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
  messageId: string | null,
  signal?: AbortSignal | null
): TypingSessionController {
  if (!messageId || signal?.aborted) {
    return { stop: () => undefined };
  }

  let stopped = false;
  const startedAt = Date.now();

  const stop = () => {
    stopped = true;
    clearInterval(interval);
    signal?.removeEventListener("abort", stop);
  };

  const interval = setInterval(() => {
    if (stopped || signal?.aborted) {
      stop();
      return;
    }
    if (Date.now() - startedAt > TYPING_MAX_DURATION_MS) return;
    void markMessageReadAndTyping(messageId, signal).then((ok) => {
      if (!ok) logWarn("whatsapp_typing_refresh_failed", "Typing refresh rejected.", { to, messageId });
    });
  }, TYPING_REFRESH_MS);

  interval.unref?.();
  signal?.addEventListener("abort", stop, { once: true });

  return { stop };
}

export interface InteractiveButton {
  id: string;
  title: string;
}

/**
 * Sends a reply-button interactive message.
 *
 * Goes through postGraphMessages so the call has the same timeout, retry, and
 * abort-signal behaviour as text sends. The body is the Cloud API button schema
 * (including recipient_type) and is not passed through formatWhatsAppMarkdown.
 */
export async function sendWhatsAppInteractiveButtons(params: {
  to: string;
  bodyText: string;
  buttons: InteractiveButton[];
  signal?: AbortSignal | null;
}): Promise<void> {
  if (params.buttons.length > 3) {
    throw new Error("WhatsApp interactive messages support a maximum of 3 buttons.");
  }

  const result = await postGraphMessages(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: params.bodyText,
        },
        action: {
          buttons: params.buttons.map((btn) => ({
            type: "reply",
            reply: {
              id: btn.id,
              title: btn.title,
            },
          })),
        },
      },
    },
    { signal: params.signal, retries: true }
  );

  if (!result.ok) {
    throw new Error(
      `WhatsApp Interactive Message Failed: HTTP ${result.status} - ${result.body}`
    );
  }
}
