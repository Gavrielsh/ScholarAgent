// Inbound WhatsApp webhook: parsing Meta's payload, then processing the message
// it carries.
//
// The two halves run in order — parseInboundDelivery normalises the raw webhook
// into a ParsedInboundEvent, which processIncomingMessage then handles.

import type {
  ParsedInboundDocumentEvent,
  ParsedInboundEvent,
  WhatsAppMessageEvent,
  WhatsAppWebhookPayload,
} from "@/lib/domain/whatsapp/types";
import { processBaselineQuery } from "@/lib/domain/chat/agent";
import { recordBaselineRagMetrics } from "@/lib/domain/chat/rag";
import {
  evaluateInboundSafety,
  redactPii,
  type InboundSafetyDecision,
} from "@/lib/security/guardrails";
import type { ChatMessage } from "@/lib/domain/chat/state";
import { lookupUserByPhone, type UserContext } from "@/lib/security/auth";
import { appendChatEntries, readChatHistory } from "@/lib/domain/chat/session/history";
import {
  buildBoundedConversationContext,
  truncateInboundMessage,
} from "@/lib/domain/chat/session/context";
import { isUniqueViolation } from "@/lib/core/db";
import { isAbortError, isHttpTimeoutError } from "@/lib/core/http/fetchWithTimeout";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import { TerminalNotifyError } from "@/lib/core/queue";
import { sendWhatsAppTextMessage, UNAUTHORIZED_NUMBER_MESSAGE } from "@/lib/domain/whatsapp/client";

// -------------------------------------------------------------------------
// Payload parsing
// -------------------------------------------------------------------------

const FALLBACK_DOCUMENT_FILENAME = "document";

/** Meta nests the payload four levels deep; every parser here starts from this. */
function firstInboundMessage(
  payload: WhatsAppWebhookPayload
): WhatsAppMessageEvent | undefined {
  return payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
}

/**
 * The raw `type` discriminator, for logging a delivery that matched no parser.
 * Without it an unhandled kind (image, audio, location, sticker…) is a silent
 * 200 and there is nothing in the logs to say what actually arrived.
 */
export function peekInboundMessageType(payload: WhatsAppWebhookPayload): string | null {
  return firstInboundMessage(payload)?.type ?? null;
}

export function isStatusOnlyWebhook(payload: WhatsAppWebhookPayload): boolean {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value?.statuses?.length) return false;
  return !value.messages?.length;
}

export function parseInboundEvent(payload: WhatsAppWebhookPayload): ParsedInboundEvent | null {
  const firstMessage = firstInboundMessage(payload);
  if (!firstMessage?.from) return null;

  const senderId = firstMessage.from;
  const messageId = firstMessage.id ?? null;

  const buttonReply = firstMessage.interactive?.button_reply;
  const listReply = firstMessage.interactive?.list_reply;
  const quickReply = firstMessage.button;

  if (
    firstMessage.type === "interactive" ||
    firstMessage.type === "button" ||
    buttonReply ||
    listReply ||
    quickReply
  ) {
    const buttonId = buttonReply?.id ?? listReply?.id ?? quickReply?.payload;
    const title = buttonReply?.title ?? listReply?.title ?? quickReply?.text ?? "";
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
 * the plain type, because the extractor table in lib/domain/ingestion/processor/uploader.ts is
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
  const firstMessage = firstInboundMessage(payload);
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

/**
 * A delivery, tagged with the queue that owns it.
 *
 * Single source of truth for the routing decision: the webhook switches on
 * `kind` and never re-inspects the payload, so "which queue does a document go
 * to" is answered in exactly one place.
 */
export type InboundDelivery =
  | { kind: "document"; event: ParsedInboundDocumentEvent }
  | { kind: "chat"; event: ParsedInboundEvent };

/**
 * Dispatches on Meta's `type` discriminator.
 *
 * `type === "document"` is authoritative; the `message.document` fallback only
 * covers a payload that carries the envelope with the field absent. Returning
 * null for a well-formed document whose media id is missing is deliberate —
 * that job could never do any work, so it must not silently become a chat turn
 * and get answered by the LLM.
 */
export function parseInboundDelivery(payload: WhatsAppWebhookPayload): InboundDelivery | null {
  const message = firstInboundMessage(payload);
  if (!message?.from) return null;

  if (message.type === "document" || message.document) {
    const event = parseInboundDocumentEvent(payload);
    return event ? { kind: "document", event } : null;
  }

  const event = parseInboundEvent(payload);
  return event ? { kind: "chat", event } : null;
}

// -------------------------------------------------------------------------
// Message processing
// -------------------------------------------------------------------------

const FALLBACK_ERROR_MESSAGE =
  "מצטערים, אירעה תקלה בעיבוד ההודעה. אפשר לנסות שוב בעוד רגע.";

/**
 * Per-attempt execution context supplied by the BullMQ worker.
 *
 * The processor needs the attempt number so it can decide whether a failure is
 * still recoverable (stay silent, let BullMQ retry) or terminal (apologise once,
 * then resolve so the retry loop stops).
 */
export interface IncomingMessageContext {
  /** 1-based index of the attempt currently executing. */
  attempt: number;
  /** Total attempts configured on the job (`job.opts.attempts`). */
  maxAttempts: number;
  /** Fires on job deadline or worker shutdown; forwarded to every network call. */
  signal: AbortSignal;
}

/**
 * Everything the pipeline is allowed to touch after redaction.
 *
 * `commandText` is the single, deliberate exception to "nothing downstream sees
 * the original text", and its use is confined to the deterministic
 * user-management parsers. It exists because `redactPii` rewrites every phone
 * number to "[PHONE_REDACTED]", so an admin typing "name, 0541234567, L1" into
 * the add-user prompt produced a string with no digits left in it and the flow
 * could never succeed. The phone number is that flow's entire payload and is
 * written to `users.phone_number` moments later, so masking it on the way in
 * protected nothing. Everything that redaction actually exists for — chat
 * history, logs, traces, the safety gate, retrieval, the LLM — still runs on
 * `redactedText`/`queryText`.
 */
interface SanitizedInbound {
  senderId: string;
  messageId: string | null;
  /** PII-masked, length-capped user text. Safe to persist, log, and trace. */
  redactedText: string;
  /** What retrieval/the LLM should answer — may be a de-identified rewrite. */
  queryText: string;
  /**
   * Truncated but NOT redacted. Admin-command parsing only — must never be
   * persisted, logged, traced, or sent to an LLM.
   */
  commandText: string;
  buttonId?: string;
}

/**
 * Deterministic id for the assistant turn derived from the inbound message id.
 *
 * Without this the outbound row has a NULL message_id, falls outside the partial
 * unique index from migration 006, and gets duplicated on every retry that
 * happens to fail after the reply was already sent.
 */
function outboundMessageId(inboundMessageId: string | null): string | undefined {
  return inboundMessageId ? `${inboundMessageId}:assistant` : undefined;
}

async function persistTurn(
  senderId: string,
  entry: { role: "user" | "assistant"; content: string; messageId?: string },
  event: string
): Promise<void> {
  try {
    await appendChatEntries(senderId, [
      {
        role: entry.role,
        content: entry.content,
        timestamp: new Date().toISOString(),
        messageId: entry.messageId,
      },
    ]);
  } catch (err) {
    // History is an audit/context store, not the product. Losing one row must
    // never cost the user their answer, so this is logged and swallowed rather
    // than propagated into the retry machinery.
    logError(event, err, { senderId });
  }
}

/**
 * Sends a terminal reply and records it, used by the safety short-circuits.
 * Persisting after the send keeps the transcript consistent with what the user
 * actually received.
 */
async function replyAndPersist(
  inbound: SanitizedInbound,
  body: string,
  signal: AbortSignal
): Promise<void> {
  await sendWhatsAppTextMessage({ to: inbound.senderId, body, signal });
  await persistTurn(
    inbound.senderId,
    { role: "assistant", content: body, messageId: outboundMessageId(inbound.messageId) },
    "chat_history_outbound_persist_failed"
  );
}

/**
 * STEP 1 — the only place raw webhook text is handled.
 *
 * Truncate first, then redact: the cap bounds the input handed to the redaction
 * regexes (an 8k ceiling instead of whatever Meta accepted), and every later
 * stage receives a string that has already been through `redactPii`.
 */
function sanitizeInbound(event: ParsedInboundEvent): SanitizedInbound {
  const truncated = truncateInboundMessage(event.messageBody);
  const redactedText = redactPii(truncated);

  return {
    senderId: event.senderId,
    messageId: event.messageId,
    redactedText,
    queryText: redactedText,
    // Same 8k cap, without the redaction pass. See SanitizedInbound.
    commandText: truncated,
    buttonId: event.buttonId,
  };
}

/**
 * Safety gate. Runs on the redacted text, before the first database write, the
 * first LLM call, and the first trace.
 *
 * Sequenced after the user lookup because the privacy tier is needed to decide
 * whether privacy rules apply. The consequence is deliberate: an *unregistered*
 * number gets UNAUTHORIZED_NUMBER_MESSAGE rather than a crisis handoff. Extending the
 * handoff to unknown senders is a product decision (it means replying to
 * arbitrary numbers), not a technical one — distress coverage here is total
 * across every registered tier, L0 through L3.
 */
function resolveSafety(inbound: SanitizedInbound, userContext: UserContext): InboundSafetyDecision {
  const decision = evaluateInboundSafety(inbound.redactedText, userContext);

  if (decision.action === "handoff") {
    logWarn("safety_mandatory_handoff", "Distress signals detected; LLM bypassed.", {
      senderId: inbound.senderId,
      messageId: inbound.messageId,
      // Level is recorded to prove the handoff fired for elevated tiers too.
      permissionLevel: userContext.permissionLevel,
      safetyRiskScore: decision.signals.safetyRiskScore,
    });
  } else if (decision.action === "block") {
    logInfo("safety_privacy_block", "Privacy guardrail returned a fixed response.", {
      senderId: inbound.senderId,
      permissionLevel: userContext.permissionLevel,
      safetyRiskScore: decision.signals.safetyRiskScore,
      intentCategory: decision.signals.intentCategory,
    });
  } else if (decision.query !== inbound.redactedText) {
    logInfo("safety_query_rewritten", "Query de-identified before retrieval.", {
      senderId: inbound.senderId,
      safetyRiskScore: decision.signals.safetyRiskScore,
    });
  }

  return decision;
}

/** Happy path. Throws on any failure; `processIncomingMessage` owns the policy. */
async function handleInboundMessage(
  event: ParsedInboundEvent,
  ctx: IncomingMessageContext
): Promise<void> {
  // ── STEP 1: redact before anything else touches the message ───────────────
  const inbound = sanitizeInbound(event);
  const { senderId, messageId } = inbound;

  // ── STEP 2: identity ──────────────────────────────────────────────────────
  // A UserRegistryDbError (Postgres unreachable) propagates on purpose: it is
  // transient, so BullMQ should retry silently rather than telling the user the
  // system is broken on the first blip. They only hear about it if every
  // attempt fails, via handleProcessingFailure.
  const userContext: UserContext | null = await lookupUserByPhone(senderId);

  if (!userContext) {
    await sendWhatsAppTextMessage({
      to: senderId,
      body: UNAUTHORIZED_NUMBER_MESSAGE,
      signal: ctx.signal,
    });
    return;
  }

  // ── STEP 3: safety gate — evaluated before the first DB write ─────────────
  const safety = resolveSafety(inbound, userContext);

  // ── STEP 4: persist the inbound turn (redacted) ───────────────────────────
  // Written on every path, including the safety short-circuits: a distress
  // message is precisely what a supervisor needs to see in the daily report.
  await persistTurn(
    senderId,
    { role: "user", content: inbound.redactedText, messageId: messageId ?? undefined },
    "chat_history_inbound_persist_failed"
  );

  if (safety.action === "handoff" || safety.action === "block") {
    await replyAndPersist(inbound, safety.response, ctx.signal);
    return;
  }

  inbound.queryText = safety.query;

  // ── STEP 5: load bounded conversation context ─────────────────────────────
  let priorMessages: ChatMessage[] = [];
  try {
    const history = await readChatHistory(senderId);
    // Drop the turn just written. Matched by message_id rather than by position:
    // with concurrency > 1 the newest row is not reliably this attempt's row,
    // and on a retry the insert was a no-op so the row is already present.
    const withoutCurrent = messageId
      ? history.entries.filter((entry) => entry.messageId !== messageId)
      : history.entries.slice(0, -1);
    priorMessages = buildBoundedConversationContext(withoutCurrent);
  } catch (err) {
    // Degrade to a stateless answer rather than failing the whole message.
    logError("chat_history_context_load_failed", err, { senderId });
  }

  // ── STEP 5: retrieval + generation ────────────────────────────────────────
  const processResult = await processBaselineQuery({
    senderPhone: senderId,
    query: inbound.queryText,
    commandText: inbound.commandText,
    userContext,
    priorMessages,
    buttonId: inbound.buttonId,
    signal: ctx.signal,
  });

  // Interactive buttons were already delivered by the handler; sending anything
  // else here would duplicate the menu.
  if (processResult.kind === "interactive_sent") {
    return;
  }

  // An empty answer means routing fell through without producing anything (see
  // the terminal `answer: ""` case in handleChatHistoryRequest). That is
  // deterministic — a retry would take the same branch and fail identically —
  // so it is answered immediately rather than thrown into the retry loop.
  const outbound = processResult.answer;
  if (!outbound) {
    logError(
      "baseline_empty_answer",
      new Error("Baseline pipeline produced an empty answer"),
      { senderId, messageId, kind: processResult.kind, intent: processResult.intent }
    );
    await replyAndPersist(inbound, FALLBACK_ERROR_MESSAGE, ctx.signal);
    return;
  }

  logInfo("whatsapp_outbound_ready", "Sending baseline reply.", {
    senderId,
    messageId,
    kind: processResult.kind,
    intent: processResult.intent,
    answerLen: outbound.length,
  });

  await sendWhatsAppTextMessage({ to: senderId, body: outbound, signal: ctx.signal });

  if (processResult.ragMetrics) {
    try {
      await recordBaselineRagMetrics({
        // The audit log stores the redacted/rewritten query, never raw input.
        query: inbound.queryText,
        userContext,
        result: processResult.ragMetrics,
      });
    } catch (err) {
      logError("baseline_post_send_metrics_failed", err, { senderId });
    }
  }

  await persistTurn(
    senderId,
    {
      role: "assistant",
      content: outbound,
      messageId: outboundMessageId(messageId),
    },
    "chat_history_outbound_persist_failed"
  );
}

/**
 * Failure policy. This is what stops the apology spam.
 *
 * Old behaviour: send an apology, then rethrow → BullMQ retried 5x → 5 apologies,
 * 5 LLM bills, 5 duplicate history rows.
 *
 * New behaviour:
 *   - unique violation  → already done by a previous attempt; resolve silently.
 *   - not the last try  → stay silent and rethrow so BullMQ retries.
 *   - the last try      → apologise exactly once, then RESOLVE so BullMQ ACKs
 *                         the job and the loop terminates.
 */
async function handleProcessingFailure(
  err: unknown,
  event: ParsedInboundEvent,
  ctx: IncomingMessageContext
): Promise<void> {
  if (err instanceof TerminalNotifyError) {
    throw err;
  }

  const { senderId, messageId } = event;
  const isFinalAttempt = ctx.attempt >= ctx.maxAttempts;

  // A duplicate key means another attempt already committed this work. Retrying
  // cannot change the outcome, so resolve and let the job complete.
  if (isUniqueViolation(err)) {
    logInfo("whatsapp_job_duplicate_ignored", "Unique violation treated as success.", {
      senderId,
      messageId,
      attempt: ctx.attempt,
    });
    return;
  }

  const aborted = isAbortError(err);
  const timedOut = isHttpTimeoutError(err);

  logError("baseline_process_failed", err, {
    senderId,
    messageId,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    isFinalAttempt,
    // Distinguishes "upstream was slow" from "we cancelled it", which otherwise
    // look identical in logs and lead to chasing the wrong provider.
    timedOut,
    aborted: aborted && !timedOut,
  });

  if (!isFinalAttempt) {
    // Silent for the user: intermediate failures are invisible, and a retry may
    // well succeed within a couple of seconds.
    throw err;
  }

  // Terminal. One apology, best effort — and crucially, no rethrow afterwards.
  try {
    await sendWhatsAppTextMessage({
      to: senderId,
      body: FALLBACK_ERROR_MESSAGE,
      // Deliberately NOT ctx.signal: if the job deadline is what failed, the
      // signal is already aborted and passing it would suppress the one message
      // the user actually needs to receive.
      signal: null,
    });
    logInfo("whatsapp_fallback_notice_sent", "Final-attempt apology delivered.", {
      senderId,
      messageId,
    });
  } catch (sendErr) {
    logError("whatsapp_fallback_notice_failed", sendErr, { senderId, messageId });
    throw new TerminalNotifyError(sendErr);
  }
}

/**
 * Business logic for one inbound message. Runs inside the BullMQ worker, which
 * owns the read receipt, typing indicator, and job deadline around this call.
 *
 * Resolves on terminal failure by design — see `handleProcessingFailure`.
 */
export async function processIncomingMessage(
  event: ParsedInboundEvent,
  ctx: IncomingMessageContext
): Promise<void> {
  try {
    await handleInboundMessage(event, ctx);
  } catch (err) {
    await handleProcessingFailure(err, event, ctx);
  }
}
