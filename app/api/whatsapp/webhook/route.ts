import { NextRequest, NextResponse } from "next/server";

import { runAgentWorkflow } from "@/lib/agent/graph";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/sendMessage";

interface WhatsAppTextMessageEvent {
  from: string;
  id: string;
  text?: {
    body: string;
  };
  type?: string;
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppTextMessageEvent[];
      };
    }>;
  }>;
}

function parseIncomingTextEvent(payload: WhatsAppWebhookPayload): {
  senderId: string | null;
  messageBody: string | null;
} {
  const firstMessage = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const isText = firstMessage?.type === "text" || !!firstMessage?.text?.body;

  if (!firstMessage || !isText) {
    return { senderId: null, messageBody: null };
  }

  return {
    senderId: firstMessage.from ?? null,
    messageBody: firstMessage.text?.body ?? null,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  // TODO: Inject this secret as WHATSAPP_VERIFY_TOKEN in environment config.
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "Webhook verification failed." }, { status: 403 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as WhatsAppWebhookPayload;
    const { senderId, messageBody } = parseIncomingTextEvent(body);

    if (!senderId || !messageBody) {
      return NextResponse.json({ ok: true, ignored: "No text message found." }, { status: 200 });
    }

    const result = await runAgentWorkflow({
      senderId,
      mission: messageBody,
      incomingMessage: messageBody,
    });

    const responseText =
      result.final_response ??
      "I received your message, but I need one more pass to provide a complete response.";

    await sendWhatsAppTextMessage({
      to: senderId,
      body: responseText,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown webhook processing error.",
      },
      { status: 500 }
    );
  }
}
