import type { ParsedInboundEvent, WhatsAppWebhookPayload } from "@/lib/whatsapp/types";

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
