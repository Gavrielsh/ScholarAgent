// Meta retries any webhook it does not see ACKed within a few seconds, which
// causes duplicate deliveries. This route therefore does the absolute minimum:
// verify the signature, claim the message id, enqueue, ACK. All real work
// (user lookup, chat history, RAG, LLM, outbound send) happens in the BullMQ
// worker — nothing that touches Postgres or an LLM belongs in this file.

import { NextRequest, NextResponse } from "next/server";

import { timingSafeStringEqual } from "@/lib/security/auth/timingSafe";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import { parsePositiveInt } from "@/lib/core/env/parseEnv";
import { enqueueDocumentIngestion } from "@/lib/domain/ingestion/queue/documentIngestionQueue";
import { enqueueWhatsAppIncomingMessage } from "@/lib/domain/whatsapp/queue/whatsappIncomingQueue";
import {
  releaseWhatsAppMessageClaim,
  tryClaimWhatsAppMessage,
} from "@/lib/core/redis/idempotency";
import {
  isStatusOnlyWebhook,
  parseInboundDelivery,
  peekInboundMessageType,
  type InboundDelivery,
} from "@/lib/domain/whatsapp/core/parseWebhook";
import { sendWhatsAppTextMessage } from "@/lib/domain/whatsapp/core/sendMessage";
import {
  isWebhookSignatureRequired,
  META_SIGNATURE_HEADER,
  verifyMetaSignature,
} from "@/lib/security/crypto/verifySignature";
import type { WhatsAppWebhookPayload } from "@/lib/domain/whatsapp/core/types";

export const runtime = "nodejs";

const DOCUMENT_RECEIPT_MESSAGE = "המסמך התקבל ונכנס לתור עיבוד.";

/**
 * Budget for the receipt send, well inside Meta's webhook patience.
 *
 * `sendWhatsAppTextMessage` retries up to 5 times with backoff, which can run
 * for tens of seconds — far longer than Meta will wait before treating this
 * delivery as failed and redelivering it. The abort signal caps the whole retry
 * loop instead of just one attempt.
 */
const RECEIPT_TIMEOUT_MS = parsePositiveInt(
  process.env.WHATSAPP_WEBHOOK_RECEIPT_TIMEOUT_MS,
  2_500
);

/** The only success response Meta needs. Kept byte-small and allocation-cheap. */
function ack(): Response {
  return new Response("OK", { status: 200 });
}

/**
 * Sends the "received, queued" confirmation before the route ACKs.
 *
 * Best effort by construction: the document is already on the queue at this
 * point, so a failed or slow confirmation must not turn into a non-2xx that
 * makes Meta redeliver a document we are about to ingest.
 *
 * Note this fires before the sender's role is known — the RBAC gate needs a
 * Postgres round trip and runs in the worker. An unauthorised sender therefore
 * gets this confirmation and then the permission error.
 */
async function sendQueuedReceipt(to: string, messageId: string | null): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECEIPT_TIMEOUT_MS);

  try {
    await sendWhatsAppTextMessage({
      to,
      body: DOCUMENT_RECEIPT_MESSAGE,
      signal: controller.signal,
    });
    logInfo("whatsapp_document_receipt_sent", "Queued-for-processing notice delivered.", {
      to,
      messageId,
    });
  } catch (err) {
    logWarn(
      "whatsapp_document_receipt_failed",
      err instanceof Error ? err.message : String(err),
      { to, messageId, timeoutMs: RECEIPT_TIMEOUT_MS }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pushes the delivery onto the queue that owns its message type.
 *
 * The type dispatch itself lives in `parseInboundDelivery`; this switch only
 * maps the resulting kind to a producer. Exhaustive by construction — adding a
 * third kind to `InboundDelivery` fails the build here rather than silently
 * falling through to the chat queue.
 *
 * The sender's role is NOT checked in this file. A `users` lookup is a database
 * round trip and Meta redelivers anything not ACKed within a few seconds, so
 * the RBAC gate lives in the ingestion worker (`authorizeSender` in
 * lib/whatsapp/documentIngestionProcessor.ts). This route always ACKs 200.
 */
function enqueueDelivery(delivery: InboundDelivery): Promise<string> {
  switch (delivery.kind) {
    case "document":
      return enqueueDocumentIngestion(delivery.event);
    case "chat":
      return enqueueWhatsAppIncomingMessage(delivery.event);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim();

  if (
    mode === "subscribe" &&
    token &&
    verifyToken &&
    timingSafeStringEqual(token, verifyToken)
  ) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "אימות ה-Webhook נכשל." }, { status: 403 });
}

export async function POST(request: NextRequest): Promise<Response> {
  // 1 — Authenticate the payload against the raw body bytes.
  const rawBody = await request.text();

  const signatureVerdict = verifyMetaSignature(
    rawBody,
    request.headers.get(META_SIGNATURE_HEADER)
  );
  if (
    signatureVerdict === "invalid" ||
    (signatureVerdict === "unconfigured" && isWebhookSignatureRequired())
  ) {
    logError("whatsapp_webhook_signature_rejected", new Error("Invalid X-Hub-Signature-256"), {
      bodyBytes: rawBody.length,
      verdict: signatureVerdict,
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

  const delivery = parseInboundDelivery(body);
  if (!delivery) {
    // Images, audio, stickers, locations, and malformed documents land here.
    // Logged with the observed type so an unsupported kind is visible in the
    // logs instead of being an unexplained silent 200.
    logInfo("whatsapp_webhook_unroutable", "No queue owns this message type.", {
      messageType: peekInboundMessageType(body),
    });
    return ack();
  }

  const { senderId, messageId } = delivery.event;

  // Deliveries without a Meta message id cannot be claimed or de-duplicated.
  // ACK without enqueue so Meta does not retry a payload we will never process
  // safely; an unidentified flood must not reach the worker.
  if (!messageId) {
    logWarn(
      "whatsapp_webhook_missing_message_id",
      "Inbound delivery dropped because it has no message id.",
      { senderId, kind: delivery.kind }
    );
    return ack();
  }

  // 2 — Idempotency: a single Redis SET NX, so Meta retries cannot double-process.
  try {
    const claimed = await tryClaimWhatsAppMessage(messageId);
    if (!claimed) {
      logInfo(
        "whatsapp_webhook_duplicate_ignored",
        "Duplicate message skipped by idempotency guard.",
        { messageId, kind: delivery.kind }
      );
      return ack();
    }
  } catch (err) {
    // Redis is down. Returning non-2xx makes Meta redeliver, which is the only
    // durability mechanism available here — do not swallow this as a 200.
    logError("whatsapp_idempotency_claim_failed", err, { messageId, senderId });
    return new Response("Service Unavailable", { status: 503 });
  }

  // 3 — Hand off to the worker that owns this kind of delivery.
  try {
    const jobId = await enqueueDelivery(delivery);
    logInfo("whatsapp_webhook_enqueued", "Inbound message queued for processing.", {
      jobId,
      kind: delivery.kind,
      messageId,
      senderId,
    });
  } catch (err) {
    try {
      await releaseWhatsAppMessageClaim(messageId);
    } catch (releaseErr) {
      logError("whatsapp_idempotency_release_failed", releaseErr, { messageId });
    }
    logError("whatsapp_webhook_enqueue_failed", err, {
      kind: delivery.kind,
      messageId: messageId ?? null,
      senderId,
    });
    return new Response("Service Unavailable", { status: 503 });
  }

  // 4 — Confirm receipt of a document before ACKing.
  //
  // Ingestion runs for anywhere between seconds and minutes, so without this the
  // admin has no feedback at all until it finishes. Chat messages skip it: the
  // worker's read receipt and typing indicator already cover that case, and a
  // second message per turn would be noise.
  if (delivery.kind === "document") {
    await sendQueuedReceipt(senderId, messageId);
  }

  // 5 — ACK.
  return ack();
}
