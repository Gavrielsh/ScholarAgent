export interface WhatsAppTextBody {
  body?: string;
}

export interface WhatsAppInteractiveReply {
  type?: string;
  button_reply?: { id?: string; title?: string };
}

export interface WhatsAppMessageEvent {
  from: string;
  id: string;
  type?: string;
  text?: WhatsAppTextBody;
  interactive?: WhatsAppInteractiveReply;
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

export const WHATSAPP_INCOMING_QUEUE_NAME = "whatsapp-incoming";
