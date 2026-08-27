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
} from "@/lib/core/queue";
import { parsePositiveInt } from "@/lib/core/env";
import { WHATSAPP_INCOMING_QUEUE_NAME, type ParsedInboundEvent } from "@/lib/domain/whatsapp/types";
import { releaseWhatsAppMessageClaim } from "@/lib/core/redis";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
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

function getIncomingQueue(): Queue<ParsedInboundEvent> {
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

export function getWhatsAppIncomingQueue(): Queue<ParsedInboundEvent> {
  return getIncomingQueue();
}

export async function enqueueWhatsAppIncomingMessage(
  event: ParsedInboundEvent
): Promise<string> {
  const job = await getIncomingQueue().add("process-incoming", event, {
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
      senderId: job.data.senderId,
      attempt: currentAttempt(job),
      pid: process.pid,
    });
  });

  worker.on("failed", async (job, err) => {
    const timedOut = err instanceof JobTimeoutError;

    logError("whatsapp_queue_job_failed", err, {
      jobId: job?.id ?? null,
      messageId: job?.data.messageId ?? null,
      senderId: job?.data.senderId ?? null,
      attemptsMade: job?.attemptsMade ?? null,
      pid: process.pid,
      // Separated so a hung upstream is greppable independently of ordinary
      // application errors.
      timedOut,
      aborted: !timedOut && isAbortError(err),
    });

    if (!job) return;

    // Reaching the final attempt via `failed` now means the processor could not
    // even deliver its apology (or the job timed out before that branch ran).
    // Release the idempotency claim so Meta's redelivery can have one more go —
    // the user has heard nothing, so a duplicate is strictly better than silence.
    const messageId = job.data.messageId;
    if (messageId && currentAttempt(job) >= maxAttempts(job)) {
      try {
        await job.remove();
      } catch (removeErr) {
        logError("whatsapp_failed_job_remove_failed", removeErr, {
          messageId,
          jobId: job.id,
        });
      }
      try {
        await releaseWhatsAppMessageClaim(messageId);
        logWarn(
          "whatsapp_idempotency_claim_released",
          "Final attempt failed without notifying the user; allowing Meta redelivery.",
          { messageId, jobId: job.id }
        );
      } catch (releaseErr) {
        logError("whatsapp_idempotency_release_failed", releaseErr, { messageId, jobId: job.id });
      }
    }
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
