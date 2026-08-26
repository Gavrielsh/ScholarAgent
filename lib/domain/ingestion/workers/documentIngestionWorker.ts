import { Worker } from "bullmq";

import { getQueueConnection } from "@/lib/core/queue/connection";
import { parsePositiveInt } from "@/lib/core/env";
import {
  currentAttempt,
  JobTimeoutError,
  LOCK_GRACE_MS,
  maxAttempts,
  runWithDeadline,
} from "@/lib/core/queue/jobRuntime";
import { isAbortError } from "@/lib/core/http/fetchWithTimeout";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import { releaseWhatsAppMessageClaim } from "@/lib/core/redis";
import { processDocumentIngestion } from "@/lib/domain/ingestion/processor/documentIngestionProcessor";
import { markMessageReadAndTyping } from "@/lib/domain/whatsapp/core/messaging";
import type { ParsedInboundDocumentEvent } from "@/lib/domain/whatsapp/core/types";
import { DOCUMENT_INGESTION_QUEUE_NAME } from "@/lib/domain/whatsapp/core/types";

/**
 * Deliberately far below the chat worker's 5.
 *
 * Each job holds a multi-megabyte buffer, a parsed document, and every chunk's
 * 768-float vector in memory at once, and they all queue behind the same Gemini
 * quota. Two concurrent ingestions saturate that quota; five just make each one
 * slower while multiplying peak RSS.
 */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RATE_LIMIT_MAX = 4;
const DEFAULT_RATE_LIMIT_DURATION_MS = 60_000;

/**
 * Hard wall-clock ceiling for one ingestion.
 *
 * Much wider than the chat worker's 90s because the work is genuinely long:
 * a 60s media download, PDF parsing, then up to 25 embedding slices that each
 * retry a 429 with up to 62s of backoff. Individual HTTP calls keep their own
 * deadlines; this is the backstop for a stall *between* them.
 */
const DEFAULT_JOB_TIMEOUT_MS = 300_000;

export function createDocumentIngestionWorker(): Worker<ParsedInboundDocumentEvent> {
  const concurrency = parsePositiveInt(
    process.env.DOCUMENT_QUEUE_CONCURRENCY,
    DEFAULT_CONCURRENCY
  );
  const rateLimitMax = parsePositiveInt(
    process.env.DOCUMENT_QUEUE_RATE_LIMIT_MAX,
    DEFAULT_RATE_LIMIT_MAX
  );
  const rateLimitDurationMs = parsePositiveInt(
    process.env.DOCUMENT_QUEUE_RATE_LIMIT_DURATION_MS,
    DEFAULT_RATE_LIMIT_DURATION_MS
  );
  const jobTimeoutMs = parsePositiveInt(
    process.env.DOCUMENT_JOB_TIMEOUT_MS,
    DEFAULT_JOB_TIMEOUT_MS
  );

  const worker = new Worker<ParsedInboundDocumentEvent>(
    DOCUMENT_INGESTION_QUEUE_NAME,
    async (job) => {
      const { messageId } = job.data;

      await runWithDeadline(job.id ?? "<unknown>", jobTimeoutMs, async (signal) => {
        // Ingestion can run for minutes with no visible feedback, so the read
        // receipt is the admin's only immediate signal that the file arrived.
        // markMessageReadAndTyping never throws — a Graph API blip cannot fail
        // the job. No typing keep-alive: this is not a conversational turn.
        if (messageId) {
          await markMessageReadAndTyping(messageId, signal);
        }

        await processDocumentIngestion(job.data, {
          attempt: currentAttempt(job),
          maxAttempts: maxAttempts(job),
          signal,
        });
      });
    },
    {
      connection: getQueueConnection(),
      concurrency,
      limiter: { max: rateLimitMax, duration: rateLimitDurationMs },
      // See LOCK_GRACE_MS: the lock must outlive the job deadline.
      lockDuration: jobTimeoutMs + LOCK_GRACE_MS,
    }
  );

  worker.on("completed", (job) => {
    logInfo("document_queue_job_completed", "Document ingestion job finished.", {
      jobId: job.id,
      messageId: job.data.messageId,
      senderId: job.data.senderId,
      filename: job.data.filename,
      attempt: currentAttempt(job),
    });
  });

  worker.on("failed", async (job, err) => {
    const timedOut = err instanceof JobTimeoutError;

    logError("document_queue_job_failed", err, {
      jobId: job?.id ?? null,
      messageId: job?.data.messageId ?? null,
      senderId: job?.data.senderId ?? null,
      filename: job?.data.filename ?? null,
      attemptsMade: job?.attemptsMade ?? null,
      timedOut,
      aborted: !timedOut && isAbortError(err),
    });

    if (!job) return;

    // Reaching `failed` on the final attempt means the processor could not even
    // deliver its failure notice (or the deadline fired before that branch ran).
    // Releasing the claim lets a Meta redelivery try once more — the admin has
    // heard nothing, so a duplicate attempt beats silence. The document row's
    // unique index on the message id keeps a successful redelivery from
    // double-ingesting.
    const messageId = job.data.messageId;
    if (messageId && currentAttempt(job) >= maxAttempts(job)) {
      try {
        await job.remove();
      } catch (removeErr) {
        logError("document_failed_job_remove_failed", removeErr, {
          messageId,
          jobId: job.id,
        });
      }
      try {
        await releaseWhatsAppMessageClaim(messageId);
        logWarn(
          "document_idempotency_claim_released",
          "Final attempt failed without notifying the sender; allowing Meta redelivery.",
          { messageId, jobId: job.id }
        );
      } catch (releaseErr) {
        logError("document_idempotency_release_failed", releaseErr, {
          messageId,
          jobId: job.id,
        });
      }
    }
  });

  worker.on("error", (err) => {
    // Connection-level problems (Redis down, auth failure). Without this handler
    // BullMQ emits on an EventEmitter with no listener, which crashes the process.
    logError("document_worker_error", err);
  });

  worker.on("stalled", (jobId) => {
    logWarn("document_queue_job_stalled", "Job lock expired and was reclaimed.", { jobId });
  });

  logInfo("document_worker_config", "Document ingestion worker initialised.", {
    concurrency,
    rateLimitMax,
    rateLimitDurationMs,
    jobTimeoutMs,
    lockDurationMs: jobTimeoutMs + LOCK_GRACE_MS,
  });

  return worker;
}
