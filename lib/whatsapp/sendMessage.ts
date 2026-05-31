import { logError, logWarn } from "@/lib/logger";

export interface SendWhatsAppTextInput {
  to: string;
  body: string;
}

interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const RTL_MARK = "\u200F";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  const exponential = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

function ensureRtl(text: string): string {
  const nonWhitespaceStart = text.trimStart();
  if (!nonWhitespaceStart) return text;
  if (nonWhitespaceStart.startsWith(RTL_MARK)) return text;
  return `${RTL_MARK}${text}`;
}

/** Validates WhatsApp Cloud API credentials before any outbound request. */
export function getWhatsAppConfig(): WhatsAppConfig {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

  if (!accessToken) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN is not configured. Set it in the environment before sending messages."
    );
  }
  if (!phoneNumberId) {
    throw new Error(
      "WHATSAPP_PHONE_NUMBER_ID is not configured. Set it in the environment before sending messages."
    );
  }

  return { accessToken, phoneNumberId };
}

export async function sendWhatsAppTextMessage(input: SendWhatsAppTextInput): Promise<void> {
  const { accessToken, phoneNumberId } = getWhatsAppConfig();
  const endpoint = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const rtlBody = ensureRtl(input.body);
  const payload = JSON.stringify({
    messaging_product: "whatsapp",
    to: input.to,
    type: "text",
    text: { body: rtlBody },
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: payload,
      });

      if (response.ok) {
        return;
      }

      const errorText = await response.text();
      const retryable = RETRYABLE_STATUS.has(response.status);

      if (!retryable || attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`WhatsApp send failed: HTTP ${response.status} ${errorText}`);
      }

      const delay = backoffDelayMs(attempt, response.headers.get("retry-after"));
      logWarn("whatsapp_send_retry", `HTTP ${response.status}, retrying`, {
        attempt: attempt + 1,
        delayMs: delay,
        to: input.to,
      });
      await sleep(delay);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLast = attempt === MAX_ATTEMPTS - 1;
      if (isLast) {
        logError("whatsapp_send_exhausted", lastError, { to: input.to, attempts: MAX_ATTEMPTS });
        throw lastError;
      }
      const delay = backoffDelayMs(attempt, null);
      logWarn("whatsapp_send_network_retry", lastError.message, {
        attempt: attempt + 1,
        delayMs: delay,
      });
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("WhatsApp send failed after retries.");
}
