// WhatsApp incoming queue and its BullMQ worker.
//
// Both stay inside lib/domain/whatsapp/ by design: the queue definition and the
// job handler are domain concerns. Only the generic plumbing they build on —
// the connection factory, the deadline race, the attempt accounting — lives in
// lib/core/queue.ts.

import { Queue, Worker } from "bullmq";
import {
  currentAttempt,
  getQueueConnection,
  JobTimeoutError,
  LOCK_GRACE_MS,
  maxAttempts,
  runWithDeadline,
  UserNotifiedFailureError,
} from "@/lib/core/queue";
import { parsePositiveInt } from "@/lib/core/env";
import { WHATSAPP_INCOMING_QUEUE_NAME, type ParsedInboundEvent } from "@/lib/domain/whatsapp/types";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import { redactPhone } from "@/lib/security/auth";
import { isAbortError } from "@/lib/core/http/fetchWithTimeout";
import { markMessageReadAndTyping, startTypingKeepAlive } from "@/lib/domain/whatsapp/client";
import { processIncomingMessage } from "@/lib/domain/whatsapp/webhook";

// -------------------------------------------------------------------------
// Queue
// -------------------------------------------------------------------------

const DEFAULT_JOB_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 2_000;

let incomingQueue: Queue<ParsedInboundEvent> | null = null;

/**
 * BullMQ rejects custom job ids containing a colon. Mirror the document queue
 * sanitiser so a late Meta redelivery cannot create a second chat job after
 * the Redis claim TTL expires.
 */
export function whatsappIncomingJobId(messageId: string): string {
  return `wa_${messageId.replace(/:/g, "_")}`;
}

export function getWhatsAppIncomingQueue(): Queue<ParsedInboundEvent> {
  if (!incomingQueue) {
    incomingQueue = new Queue<ParsedInboundEvent>(WHATSAPP_INCOMING_QUEUE_NAME, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: parsePositiveInt(
          process.env.WHATSAPP_INCOMING_JOB_ATTEMPTS,
          DEFAULT_JOB_ATTEMPTS
        ),
        backoff: { type: "exponential", delay: DEFAULT_BACKOFF_MS },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
  }
  return incomingQueue;
}

export async function enqueueWhatsAppIncomingMessage(
  event: ParsedInboundEvent
): Promise<string> {
  const job = await getWhatsAppIncomingQueue().add("process-incoming", event, {
    jobId: event.messageId ? whatsappIncomingJobId(event.messageId) : undefined,
  });
  return job.id ?? String(job.name);
}

export async function closeWhatsAppIncomingQueue(): Promise<void> {
  if (!incomingQueue) return;
  const queue = incomingQueue;
  incomingQueue = null;
  await queue.close();
}

// -------------------------------------------------------------------------
// Worker
// -------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_DURATION_MS = 1_000;

/**
 * Hard wall-clock ceiling for one job.
 *
 * Sized above the realistic worst case so it only ever fires on a genuine hang:
 * embedding (15s) + retrieval + generation (15s) + a send that may retry 5x
 * with backoff. Individual HTTP calls have their own 15s deadlines, so this is
 * the backstop for a stall that happens *between* network calls (a wedged
 * Postgres client, a pathological regex, an await that never settles).
 */
const DEFAULT_JOB_TIMEOUT_MS = 90_000;

export function createWhatsAppIncomingWorker(): Worker<ParsedInboundEvent> {
  const concurrency = parsePositiveInt(process.env.WHATSAPP_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY);
  const rateLimitMax = parsePositiveInt(
    process.env.WHATSAPP_QUEUE_RATE_LIMIT_MAX,
    DEFAULT_RATE_LIMIT_MAX
  );
  const rateLimitDurationMs = parsePositiveInt(
    process.env.WHATSAPP_QUEUE_RATE_LIMIT_DURATION_MS,
    DEFAULT_RATE_LIMIT_DURATION_MS
  );
  const jobTimeoutMs = parsePositiveInt(
    process.env.WHATSAPP_JOB_TIMEOUT_MS,
    DEFAULT_JOB_TIMEOUT_MS
  );

  const worker = new Worker<ParsedInboundEvent>(
    WHATSAPP_INCOMING_QUEUE_NAME,
    async (job) => {
      const { messageId, senderId } = job.data;

      await runWithDeadline(job.id ?? "<unknown>", jobTimeoutMs, async (signal) => {
        // UX first: the RAG + LLM pipeline takes 1–3s, so acknowledge the message
        // and show "typing…" before any of that work starts. markMessageReadAndTyping
        // never throws, so a Graph API failure cannot fail or retry the job.
        if (messageId) {
          await markMessageReadAndTyping(messageId, signal);
        }

        const typing = startTypingKeepAlive(senderId, messageId, signal);
        try {
          await processIncomingMessage(job.data, {
            attempt: currentAttempt(job),
            maxAttempts: maxAttempts(job),
            signal,
          });
        } finally {
          // Must run even on timeout, or the 20s keep-alive interval outlives
          // the job and keeps poking the Graph API for a conversation that ended.
          typing.stop();
        }
      });
    },
    {
      connection: getQueueConnection(),
      concurrency,
      limiter: {
        max: rateLimitMax,
        duration: rateLimitDurationMs,
      },
      // See LOCK_GRACE_MS: the lock must outlive the job deadline.
      lockDuration: jobTimeoutMs + LOCK_GRACE_MS,
    }
  );

  worker.on("completed", (job) => {
    logInfo("whatsapp_queue_job_completed", "Incoming WhatsApp message processed.", {
      jobId: job.id,
      messageId: job.data.messageId,
      senderId: redactPhone(job.data.senderId),
      attempt: currentAttempt(job),
      pid: process.pid,
    });
  });

  worker.on("failed", (job, err) => {
    const timedOut = err instanceof JobTimeoutError;

    // Terminal failures stay in BullMQ's `failed` set (bounded by `removeOnFail`
    // on the queue) so they can be inspected and, if need be, re-run by hand
    // with `job.retry()`. This handler deliberately does not remove the job: the
    // earlier "remove it and release the idempotency claim so Meta redelivers"
    // recovery never fired in practice, because Meta stops redelivering once the
    // webhook has ACKed — and it destroyed the only record of the failure.
    logError("whatsapp_queue_job_failed", err, {
      jobId: job?.id ?? null,
      messageId: job?.data.messageId ?? null,
      senderId: job ? redactPhone(job.data.senderId) : null,
      attemptsMade: job?.attemptsMade ?? null,
      pid: process.pid,
      // True when the user already received the apology, i.e. this failure is a
      // record for operators rather than a message that went unanswered.
      userNotified: err instanceof UserNotifiedFailureError,
      // Separated so a hung upstream is greppable independently of ordinary
      // application errors.
      timedOut,
      aborted: !timedOut && isAbortError(err),
    });
  });

  worker.on("error", (err) => {
    // Connection-level problems (Redis down, auth failure). Without this handler
    // BullMQ emits on an EventEmitter with no listener, which crashes the process.
    logError("whatsapp_worker_error", err);
  });

  worker.on("stalled", (jobId) => {
    logWarn("whatsapp_queue_job_stalled", "Job lock expired and was reclaimed.", { jobId });
  });

  logInfo("whatsapp_worker_config", "WhatsApp worker initialised.", {
    concurrency,
    rateLimitMax,
    rateLimitDurationMs,
    jobTimeoutMs,
    lockDurationMs: jobTimeoutMs + LOCK_GRACE_MS,
  });

  return worker;
}
