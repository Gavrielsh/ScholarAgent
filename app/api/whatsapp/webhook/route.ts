import { NextRequest, NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/logger";
import { enqueueWhatsAppIncomingMessage } from "@/lib/queue/whatsappIncomingQueue";
import {
  releaseWhatsAppMessageClaim,
  tryClaimWhatsAppMessage,
} from "@/lib/redis/idempotency";
import { isStatusOnlyWebhook, parseInboundEvent } from "@/lib/whatsapp/parseWebhook";
import type { WhatsAppWebhookPayload } from "@/lib/whatsapp/types";

export const runtime = "nodejs";

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
  let body: WhatsAppWebhookPayload;
  try {
    body = (await request.json()) as WhatsAppWebhookPayload;
  } catch {
    return NextResponse.json({ ok: true, ignored: "מטען JSON לא תקין." }, { status: 200 });
  }

  if (isStatusOnlyWebhook(body)) {
    return NextResponse.json({ ok: true, ignored: "status_update" }, { status: 200 });
  }

  const event = parseInboundEvent(body);
  if (!event) {
    return NextResponse.json({ ok: true, ignored: "לא נמצאה הודעה נתמכת במטען." }, { status: 200 });
  }

  if (event.messageId) {
    try {
      const claimed = await tryClaimWhatsAppMessage(event.messageId);
      if (!claimed) {
        logInfo("whatsapp_webhook_duplicate_ignored", "Duplicate message skipped by idempotency guard.", {
          messageId: event.messageId,
        });
        return NextResponse.json({ ok: true, status: "duplicate_ignored" }, { status: 200 });
      }
    } catch (err) {
      logError("whatsapp_idempotency_claim_failed", err, {
        messageId: event.messageId,
        senderId: event.senderId,
      });
      return NextResponse.json({ ok: false, error: "idempotency_unavailable" }, { status: 503 });
    }
  }

  try {
    const jobId = await enqueueWhatsAppIncomingMessage(event);
    logInfo("whatsapp_webhook_enqueued", "Inbound message queued for processing.", {
      jobId,
      messageId: event.messageId,
      senderId: event.senderId,
    });
  } catch (err) {
    if (event.messageId) {
      try {
        await releaseWhatsAppMessageClaim(event.messageId);
      } catch (releaseErr) {
        logError("whatsapp_idempotency_release_failed", releaseErr, {
          messageId: event.messageId,
        });
      }
    }
    logError("whatsapp_webhook_enqueue_failed", err, {
      messageId: event.messageId ?? null,
      senderId: event.senderId,
    });
    return NextResponse.json({ ok: false, error: "queue_unavailable" }, { status: 503 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
