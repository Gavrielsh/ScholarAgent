import { NextRequest, NextResponse } from "next/server";

import { runAgentWorkflow } from "@/lib/agent/graph";
import { appendChatEntries } from "@/lib/chat/history";
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

interface ParsedTextEvent {
  senderId: string;
  messageBody: string;
  messageId: string | null;
}

function parseIncomingTextEvent(payload: WhatsAppWebhookPayload): ParsedTextEvent | null {
  const firstMessage = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!firstMessage) return null;

  const isText = firstMessage.type === "text" || !!firstMessage.text?.body;
  if (!isText) return null;

  const senderId = firstMessage.from;
  const messageBody = firstMessage.text?.body;
  if (!senderId || !messageBody) return null;

  return {
    senderId,
    messageBody,
    messageId: firstMessage.id ?? null,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "אימות ה-Webhook נכשל." }, { status: 403 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 1: parse the inbound payload defensively. Any malformed structure
  // returns 200 with `ignored: true` so Meta does not retry the webhook.
  let body: WhatsAppWebhookPayload;
  try {
    body = (await request.json()) as WhatsAppWebhookPayload;
  } catch {
    return NextResponse.json({ ok: true, ignored: "מטען JSON לא תקין." }, { status: 200 });
  }

  const event = parseIncomingTextEvent(body);
  if (!event) {
    return NextResponse.json(
      { ok: true, ignored: "לא נמצאה הודעת טקסט נתמכת במטען." },
      { status: 200 }
    );
  }

  const { senderId, messageBody, messageId } = event;
  const receivedAt = new Date().toISOString();

  // Step 2: persist the inbound message immediately. We do not block on
  // failures here — losing a single history append must never prevent the
  // user from getting a reply. Errors are logged and recovery is deferred.
  try {
    await appendChatEntries(senderId, [
      {
        role: "user",
        content: messageBody,
        timestamp: receivedAt,
        messageId: messageId ?? undefined,
      },
    ]);
  } catch (err) {
    // TODO: Wire structured logging / alerting; do not crash the webhook.
    console.error("Failed to persist inbound chat entry:", err);
  }

  // Step 3: run the agent workflow. Any error here yields a graceful fallback
  // text so the user always receives some reply.
  let responseText: string;
  try {
    const result = await runAgentWorkflow({
      senderId,
      mission: messageBody,
      incomingMessage: messageBody,
    });

    responseText = String(
      result.final_response ??
        "קיבלתי את ההודעה שלך, ואני צריך עוד רגע כדי לספק תשובה מלאה יותר."
    );
  } catch (err) {
    console.error("Agent workflow error:", err);
    responseText = "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";
  }

  // Step 4: send the reply over WhatsApp. If sending fails we still record
  // the assistant turn so the conversation log stays consistent on next retry.
  let sendError: string | null = null;
  try {
    await sendWhatsAppTextMessage({ to: senderId, body: responseText });
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error("Failed to send WhatsApp reply:", err);
  }

  // Step 5: persist the outbound message (and any send error) for audit.
  try {
    await appendChatEntries(senderId, [
      {
        role: "assistant",
        content: responseText,
        timestamp: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    console.error("Failed to persist assistant chat entry:", err);
  }

  // We always return 200 to Meta unless something catastrophic happened.
  // Internal failures are reflected in the JSON body for our own monitoring.
  return NextResponse.json(
    { ok: sendError === null, sendError },
    { status: sendError === null ? 200 : 502 }
  );
}
