import {
  abortableSleep,
  fetchTextWithTimeout,
  isAbortError,
  isHttpAbortedError,
  isHttpTimeoutError,
} from "@/lib/http/fetchWithTimeout";
import { logError, logWarn } from "@/lib/logger";
import { formatWhatsAppMarkdown } from "@/lib/whatsapp/formatting";

export interface SendWhatsAppTextInput {
  to: string;
  body: string;
  /**
   * Job-level cancellation. When it fires the retry loop stops immediately
   * instead of burning the remaining attempts (and their backoffs) against a
   * job that is already being torn down.
   */
  signal?: AbortSignal | null;
}

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  apiBaseUrl: string;
  apiVersion: string;
}

const DEFAULT_API_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v20.0";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const RTL_MARK = "\u200F";

/**
 * Per-request deadline. Deliberately below the queue's job deadline so a slow
 * Graph API surfaces as a retryable send failure rather than as a job timeout
 * that kills the whole pipeline mid-flight.
 */
export const WHATSAPP_HTTP_TIMEOUT_MS = Number(process.env.WHATSAPP_HTTP_TIMEOUT_MS ?? 15_000);

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

function normalizeApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_API_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function normalizeApiVersion(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_API_VERSION;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/** Validates WhatsApp Cloud API credentials and endpoint settings before any outbound request. */
export function getWhatsAppConfig(): WhatsAppConfig {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const apiBaseUrl = normalizeApiBaseUrl(process.env.WHATSAPP_API_BASE_URL);
  const apiVersion = normalizeApiVersion(
    process.env.WHATSAPP_API_VERSION ?? process.env.WHATSAPP_GRAPH_API_VERSION
  );

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

  return { accessToken, phoneNumberId, apiBaseUrl, apiVersion };
}

export function buildWhatsAppMessagesEndpoint(config: WhatsAppConfig): string {
  return `${config.apiBaseUrl}/${config.apiVersion}/${config.phoneNumberId}/messages`;
}

export interface GraphSendResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface PostGraphMessagesOptions {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  /** Default true for user-visible sends. Typing/read receipts pass false. */
  retries?: boolean;
}

/**
 * Single Graph `/messages` POST used by text, interactive, and typing helpers.
 */
export async function postGraphMessages(
  payload: Record<string, unknown>,
  options: PostGraphMessagesOptions = {}
): Promise<GraphSendResult> {
  const config = getWhatsAppConfig();
  const endpoint = buildWhatsAppMessagesEndpoint(config);
  const body = JSON.stringify(payload);
  const timeoutMs = options.timeoutMs ?? WHATSAPP_HTTP_TIMEOUT_MS;
  const maxAttempts = options.retries === false ? 1 : MAX_ATTEMPTS;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new Error("WhatsApp send cancelled before completion.");
    }

    try {
      const response = await fetchTextWithTimeout(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body,
        signal: options.signal,
        timeoutMs,
        label: "GraphAPI/messages",
      });

      if (response.ok) {
        return { ok: true, status: response.status, body: response.body };
      }

      const retryable = RETRYABLE_STATUS.has(response.status);
      if (!retryable || attempt === maxAttempts - 1) {
        return { ok: false, status: response.status, body: response.body };
      }

      const delay = backoffDelayMs(attempt, response.headers.get("retry-after"));
      logWarn("whatsapp_send_retry", `HTTP ${response.status}, retrying`, {
        attempt: attempt + 1,
        delayMs: delay,
      });
      await abortableSleep(delay, options.signal);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (isHttpAbortedError(lastError) || options.signal?.aborted) {
        logWarn("whatsapp_send_cancelled", lastError.message, { attempt: attempt + 1 });
        throw lastError;
      }

      const isLast = attempt === maxAttempts - 1;
      if (isLast) {
        logError("whatsapp_send_exhausted", lastError, {
          attempts: maxAttempts,
          timedOut: isHttpTimeoutError(lastError),
        });
        throw lastError;
      }

      const delay = backoffDelayMs(attempt, null);
      logWarn("whatsapp_send_network_retry", lastError.message, {
        attempt: attempt + 1,
        delayMs: delay,
        timedOut: isHttpTimeoutError(lastError),
        aborted: isAbortError(lastError),
      });
      await abortableSleep(delay, options.signal);
    }
  }

  throw lastError ?? new Error("WhatsApp send failed after retries.");
}

export async function sendWhatsAppTextMessage(input: SendWhatsAppTextInput): Promise<void> {
  const rtlBody = ensureRtl(formatWhatsAppMarkdown(input.body));
  const result = await postGraphMessages(
    {
      messaging_product: "whatsapp",
      to: input.to,
      type: "text",
      text: { body: rtlBody },
    },
    { signal: input.signal, retries: true }
  );

  if (!result.ok) {
    throw new Error(`WhatsApp send failed: HTTP ${result.status} ${result.body}`);
  }
}
