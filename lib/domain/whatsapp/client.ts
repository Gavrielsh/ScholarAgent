// WhatsApp Graph API client: outbound messaging, text formatting and media
// download.
//
// Sections are in dependency order — formatting and the user-facing strings have
// no dependencies, sendMessage builds on formatting, and messaging and
// mediaDownload build on sendMessage.
//
// The inbound webhook shapes and the queue-name constants live in
// lib/domain/whatsapp/types.ts, not here: nothing in this file references them,
// and the ingestion domain imports them without wanting the Graph API client.

import {
  abortableSleep,
  fetchBinaryWithTimeout,
  fetchTextWithTimeout,
  isAbortError,
  isHttpAbortedError,
  isHttpPayloadTooLargeError,
  isHttpTimeoutError,
  parseJsonBody,
} from "@/lib/core/http/fetchWithTimeout";
import { logError, logInfo, logWarn } from "@/lib/core/logger";

// -------------------------------------------------------------------------
// Text formatting
// -------------------------------------------------------------------------

/** WhatsApp Cloud API hard limit for a text body. */
export const WHATSAPP_TEXT_CHAR_LIMIT = 4096;

/**
 * Normalises LLM output for WhatsApp delivery.
 *
 * WhatsApp renders bold as single asterisks (*bold*); the Markdown-style double
 * asterisk (**bold**) leaks through as literal characters. The system directives
 * ask the model for single asterisks, but this is the deterministic backstop for
 * when it ignores them.
 */
export function formatWhatsAppMarkdown(text: string): string {
  return text.replace(/\*\*/g, "*").trim();
}

/**
 * Splits `text` into pieces that each fit `limit`, preferring newline then
 * space so a user-table row is not cut mid-line.
 */
export function chunkWhatsAppText(text: string, limit = WHATSAPP_TEXT_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

// -------------------------------------------------------------------------
// User-facing messages
// -------------------------------------------------------------------------

/** Sent when an inbound WhatsApp number is not in the user registry. */
export const UNAUTHORIZED_NUMBER_MESSAGE =
  "המספר אינו מזוהה במערכת. יש לפנות לאחד האחראים כדי להסדיר את הגישה.";

// -------------------------------------------------------------------------
// Sending
// -------------------------------------------------------------------------

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

function buildWhatsAppMessagesEndpoint(config: WhatsAppConfig): string {
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
  const formatted = formatWhatsAppMarkdown(input.body);
  const maxContent = WHATSAPP_TEXT_CHAR_LIMIT - RTL_MARK.length;
  const parts = chunkWhatsAppText(formatted, maxContent);

  for (const part of parts) {
    const rtlBody = ensureRtl(part);
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
}

// -------------------------------------------------------------------------
// Messaging helpers
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Media download
// -------------------------------------------------------------------------

// Two-step Graph API media retrieval, as required by the WhatsApp Cloud API:
//
//   1. GET /{version}/{media-id}          → JSON envelope with a short-lived URL
//   2. GET <that url>                     → the bytes, Bearer token still required
//
// Both hops go through lib/core/http/fetchWithTimeout.ts so they inherit the same
// AbortController deadline discipline as every other outbound call here, and
// both are cancellable by the BullMQ job signal.

/** 20 MB — comfortably above Meta's own 100 MB document cap for what we accept. */
const WHATSAPP_MEDIA_MAX_BYTES = Number(
  process.env.WHATSAPP_MEDIA_MAX_BYTES ?? 20 * 1024 * 1024
);

const MEDIA_METADATA_TIMEOUT_MS = Number(
  process.env.WHATSAPP_MEDIA_METADATA_TIMEOUT_MS ?? 15_000
);
/** Wider than a normal call: this one moves megabytes over a mobile-origin CDN. */
const MEDIA_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS ?? 60_000
);

/**
 * Hosts the downloader is willing to talk to.
 *
 * The URL in step 1 is data returned by an upstream service, and step 2 sends
 * our Graph API bearer token to whatever it points at. Without this allow-list,
 * anyone who can influence that response gets a server-side request forgery
 * primitive *and* a credential exfiltration channel.
 */
const ALLOWED_MEDIA_HOST_SUFFIXES = [
  "graph.facebook.com",
  "lookaside.fbsbx.com",
  ".fbcdn.net",
  ".facebook.com",
  ".whatsapp.net",
];

export class WhatsAppMediaError extends Error {
  readonly status: number | null;
  /** False for 4xx and policy rejections — a retry would fail identically. */
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "WhatsAppMediaError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export function isRetryableMediaError(err: unknown): boolean {
  if (err instanceof WhatsAppMediaError) return err.retryable;
  return isHttpTimeoutError(err);
}

interface MediaMetadataResponse {
  url?: string;
  mime_type?: string;
  file_size?: number;
  sha256?: string;
}

export interface WhatsAppMediaMetadata {
  url: string;
  mimeType: string | null;
  fileSize: number | null;
  sha256: string | null;
}

export interface DownloadedMedia {
  bytes: ArrayBuffer;
  /** Meta's reported type, when present. The webhook's value stays authoritative. */
  mimeType: string | null;
  sizeBytes: number;
  sha256: string | null;
}

function classifyStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function assertAllowedMediaUrl(rawUrl: string, apiBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WhatsAppMediaError("Graph API returned a malformed media URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new WhatsAppMediaError(`Refusing a non-HTTPS media URL (${parsed.protocol}).`);
  }

  // The configured base URL is trusted too, so a local Graph API stub used in
  // development or integration tests does not have to be on Meta's domains.
  let configuredHost: string | null = null;
  try {
    configuredHost = new URL(apiBaseUrl).hostname;
  } catch {
    configuredHost = null;
  }

  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === configuredHost ||
    ALLOWED_MEDIA_HOST_SUFFIXES.some((suffix) =>
      suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix
    );

  if (!allowed) {
    throw new WhatsAppMediaError(`Refusing a media URL on an untrusted host (${host}).`);
  }

  return parsed;
}

/** Step 1 — resolve the opaque media id into a signed, short-lived download URL. */
async function resolveWhatsAppMediaUrl(
  mediaId: string,
  signal?: AbortSignal | null
): Promise<WhatsAppMediaMetadata> {
  const config = getWhatsAppConfig();
  const endpoint = `${config.apiBaseUrl}/${config.apiVersion}/${encodeURIComponent(mediaId)}`;

  const response = await fetchTextWithTimeout(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.accessToken}` },
    timeoutMs: MEDIA_METADATA_TIMEOUT_MS,
    signal,
    label: "GraphAPI/media-metadata",
  });

  if (!response.ok) {
    throw new WhatsAppMediaError(
      `Media metadata lookup failed: HTTP ${response.status} ${response.body.slice(0, 300)}`,
      { status: response.status, retryable: classifyStatus(response.status) }
    );
  }

  const json = parseJsonBody<MediaMetadataResponse>(response.body, "GraphAPI/media-metadata");
  if (!json.url) {
    throw new WhatsAppMediaError("Media metadata response contained no download URL.");
  }

  return {
    url: json.url,
    mimeType: json.mime_type?.split(";")[0].trim().toLowerCase() || null,
    fileSize: Number.isFinite(json.file_size) ? Number(json.file_size) : null,
    sha256: json.sha256 ?? null,
  };
}

/**
 * Steps 1 + 2. Returns the raw bytes; parsing is the caller's concern
 * (see `extractTextFromUpload` in lib/domain/ingestion/processor/uploader.ts).
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  options: { signal?: AbortSignal | null; maxBytes?: number } = {}
): Promise<DownloadedMedia> {
  const config = getWhatsAppConfig();
  const maxBytes = options.maxBytes ?? WHATSAPP_MEDIA_MAX_BYTES;
  const metadata = await resolveWhatsAppMediaUrl(mediaId, options.signal);

  if (metadata.fileSize !== null && metadata.fileSize > maxBytes) {
    throw new WhatsAppMediaError(
      `Media is ${metadata.fileSize} bytes, above the ${maxBytes}-byte limit.`
    );
  }

  const url = assertAllowedMediaUrl(metadata.url, config.apiBaseUrl);

  let response;
  try {
    response = await fetchBinaryWithTimeout(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${config.accessToken}` },
      timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
      signal: options.signal,
      maxBytes,
      label: "GraphAPI/media-download",
    });
  } catch (err) {
    if (isHttpPayloadTooLargeError(err)) {
      throw new WhatsAppMediaError(`Media exceeded the ${maxBytes}-byte download limit.`);
    }
    throw err;
  }

  if (!response.ok) {
    throw new WhatsAppMediaError(`Media download failed: HTTP ${response.status}`, {
      status: response.status,
      retryable: classifyStatus(response.status),
    });
  }

  if (response.body.byteLength === 0) {
    throw new WhatsAppMediaError("Media download returned an empty body.");
  }

  logInfo("whatsapp_media_downloaded", "Fetched document bytes from the Graph API.", {
    mediaId,
    sizeBytes: response.body.byteLength,
    mimeType: metadata.mimeType,
  });

  return {
    bytes: response.body,
    mimeType: metadata.mimeType,
    sizeBytes: response.body.byteLength,
    sha256: metadata.sha256,
  };
}
