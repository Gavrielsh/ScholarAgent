export interface SendWhatsAppTextInput {
  to: string;
  body: string;
}

export async function sendWhatsAppTextMessage(input: SendWhatsAppTextInput): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    // TODO: Inject WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in environment config.
    throw new Error(
      "Missing WhatsApp env vars: WHATSAPP_ACCESS_TOKEN and/or WHATSAPP_PHONE_NUMBER_ID."
    );
  }

  const endpoint = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: input.to,
      type: "text",
      text: {
        body: input.body,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp send failed: ${response.status} ${errorText}`);
  }
}
