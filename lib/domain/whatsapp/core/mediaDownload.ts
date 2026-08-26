// Two-step Graph API media retrieval, as required by the WhatsApp Cloud API:
//
//   1. GET /{version}/{media-id}          → JSON envelope with a short-lived URL
//   2. GET <that url>                     → the bytes, Bearer token still required
//
// Both hops go through lib/core/http/fetchWithTimeout.ts so they inherit the same
// AbortController deadline discipline as every other outbound call here, and
// both are cancellable by the BullMQ job signal.

import {
  fetchBinaryWithTimeout,
  fetchTextWithTimeout,
  isHttpPayloadTooLargeError,
  isHttpTimeoutError,
  parseJsonBody,
} from "@/lib/core/http/fetchWithTimeout";
import { logInfo } from "@/lib/core/logger";
import { getWhatsAppConfig } from "@/lib/domain/whatsapp/core/sendMessage";

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
