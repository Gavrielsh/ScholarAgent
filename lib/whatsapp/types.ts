export interface WhatsAppTextBody {
  body?: string;
}

export interface WhatsAppInteractiveReply {
  type?: string;
  button_reply?: { id?: string; title?: string };
}

/** Media envelope Meta sends for `type: "document"` (also image/audio/video). */
export interface WhatsAppMediaBody {
  /** Opaque media handle; resolved to a signed URL via the Graph API. */
  id?: string;
  mime_type?: string;
  sha256?: string;
  filename?: string;
  caption?: string;
}

export interface WhatsAppMessageEvent {
  from: string;
  id: string;
  type?: string;
  text?: WhatsAppTextBody;
  interactive?: WhatsAppInteractiveReply;
  document?: WhatsAppMediaBody;
}

export interface WhatsAppWebhookPayload {
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

export interface ParsedInboundEvent {
  senderId: string;
  messageBody: string;
  messageId: string | null;
  buttonId?: string;
}

/**
 * An inbound document, normalised into the payload the ingestion queue carries.
 *
 * Deliberately NOT merged into `ParsedInboundEvent`: the two travel on separate
 * queues with different retry budgets and different consumers, and a union type
 * would force every existing chat call site to narrow for a case it can never see.
 */
export interface ParsedInboundDocumentEvent {
  senderId: string;
  messageId: string | null;
  /** Graph API media handle. The download URL is issued from this, on demand. */
  mediaId: string;
  /** Lower-cased, parameter-stripped (`text/plain; charset=utf-8` → `text/plain`). */
  mimeType: string;
  filename: string;
  /** Free text the admin typed with the attachment; may carry a level directive. */
  caption: string | null;
  /** Meta's checksum, stored for provenance. Not verified locally. */
  sha256: string | null;
}

export const WHATSAPP_INCOMING_QUEUE_NAME = "whatsapp-incoming";
export const DOCUMENT_INGESTION_QUEUE_NAME = "document-ingestion";
