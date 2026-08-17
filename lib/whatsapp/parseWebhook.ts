import type {
  ParsedInboundDocumentEvent,
  ParsedInboundEvent,
  WhatsAppWebhookPayload,
} from "@/lib/whatsapp/types";

const FALLBACK_DOCUMENT_FILENAME = "document";

export function isStatusOnlyWebhook(payload: WhatsAppWebhookPayload): boolean {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value?.statuses?.length) return false;
  return !value.messages?.length;
}

export function parseInboundEvent(payload: WhatsAppWebhookPayload): ParsedInboundEvent | null {
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

/**
 * `application/pdf; charset=binary` and `APPLICATION/PDF` both have to resolve to
 * the plain type, because the extractor table in lib/ingestion/uploader.ts is
 * keyed on the exact lower-case MIME string.
 */
function normalizeMimeType(raw: string): string {
  return raw.split(";")[0].trim().toLowerCase();
}

/**
 * The filename is attacker-controlled (it is whatever the sender's phone put in
 * the envelope) and ends up in metadata, logs, and admin reports. It is never
 * used as a filesystem path here, but stripping separators and control
 * characters keeps that true even if a future caller does write it to disk.
 */
function sanitizeFilename(raw: string | undefined, mimeType: string): string {
  const cleaned = (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 255);
  if (cleaned) return cleaned;
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "";
  return extension ? `${FALLBACK_DOCUMENT_FILENAME}.${extension}` : FALLBACK_DOCUMENT_FILENAME;
}

/**
 * Extracts a document attachment from the webhook payload.
 *
 * Returns null for every other message shape, so the route can try this first
 * and fall through to `parseInboundEvent` for text/interactive without either
 * parser having to know about the other. A document message carries no
 * `text.body`, so `parseInboundEvent` already declines it.
 */
export function parseInboundDocumentEvent(
  payload: WhatsAppWebhookPayload
): ParsedInboundDocumentEvent | null {
  const firstMessage = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!firstMessage?.from) return null;

  const isDocument = firstMessage.type === "document" || !!firstMessage.document?.id;
  if (!isDocument) return null;

  const mediaId = firstMessage.document?.id?.trim();
  const rawMimeType = firstMessage.document?.mime_type?.trim();
  // Without either of these the job cannot download or parse anything, so it is
  // dropped at the edge rather than enqueued to fail five times in the worker.
  if (!mediaId || !rawMimeType) return null;

  const mimeType = normalizeMimeType(rawMimeType);
  if (!mimeType) return null;

  const caption = firstMessage.document?.caption?.trim();

  return {
    senderId: firstMessage.from,
    messageId: firstMessage.id ?? null,
    mediaId,
    mimeType,
    filename: sanitizeFilename(firstMessage.document?.filename, mimeType),
    caption: caption || null,
    sha256: firstMessage.document?.sha256?.trim() || null,
  };
}
