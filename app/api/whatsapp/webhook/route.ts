// Meta retries any webhook it does not see ACKed within a few seconds, which
// causes duplicate deliveries. This route therefore does the absolute minimum:
// verify the signature, claim the message id, enqueue, ACK. All real work
// (user lookup, chat history, RAG, LLM, outbound send) happens in the BullMQ
// worker — nothing that touches Postgres or an LLM belongs in this file.

import { NextRequest, NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/logger";
import { enqueueWhatsAppIncomingMessage } from "@/lib/queue/whatsappIncomingQueue";
import {
  releaseWhatsAppMessageClaim,
  tryClaimWhatsAppMessage,
} from "@/lib/redis/idempotency";
import { isStatusOnlyWebhook, parseInboundEvent } from "@/lib/whatsapp/parseWebhook";
import { META_SIGNATURE_HEADER, verifyMetaSignature } from "@/lib/whatsapp/verifySignature";
import type { WhatsAppWebhookPayload } from "@/lib/whatsapp/types";

export const runtime = "nodejs";

/** The only success response Meta needs. Kept byte-small and allocation-cheap. */
function ack(): Response {
  return new Response("OK", { status: 200 });
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

export async function POST(request: NextRequest): Promise<Response> {
  // 1 — Authenticate the payload against the raw body bytes.
  const rawBody = await request.text();

  if (verifyMetaSignature(rawBody, request.headers.get(META_SIGNATURE_HEADER)) === "invalid") {
    logError("whatsapp_webhook_signature_rejected", new Error("Invalid X-Hub-Signature-256"), {
      bodyBytes: rawBody.length,
    });
    return new Response("Forbidden", { status: 403 });
  }

  let body: WhatsAppWebhookPayload;
  try {
    body = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return ack();
  }

  // Delivery/read receipts carry no inbound message — ACK and drop.
  if (isStatusOnlyWebhook(body)) {
    return ack();
  }

  const event = parseInboundEvent(body);
  if (!event) {
    return ack();
  }

  // 2 — Idempotency: a single Redis SET NX, so Meta retries cannot double-process.
  if (event.messageId) {
    try {
      const claimed = await tryClaimWhatsAppMessage(event.messageId);
      if (!claimed) {
        logInfo(
          "whatsapp_webhook_duplicate_ignored",
          "Duplicate message skipped by idempotency guard.",
          { messageId: event.messageId }
        );
        return ack();
      }
    } catch (err) {
      // Redis is down. Returning non-2xx makes Meta redeliver, which is the only
      // durability mechanism available here — do not swallow this as a 200.
      logError("whatsapp_idempotency_claim_failed", err, {
        messageId: event.messageId,
        senderId: event.senderId,
      });
      return new Response("Service Unavailable", { status: 503 });
    }
  }

  // 3 — Hand off to the worker.
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
    return new Response("Service Unavailable", { status: 503 });
  }

  // 4 — ACK immediately.
  return ack();
}
