// Document ingestion queue and its BullMQ worker.
//
// Both stay inside lib/domain/ingestion/: the queue definition and the job
// handler are domain concerns. Only the generic plumbing they build on lives in
// lib/core/queue.ts.
//
// IMPORTANT: this file must NOT import lib/domain/ingestion/pipeline.ts at the
// top level. The producer half (enqueueDocumentIngestion) is imported by
// app/api/whatsapp/webhook/route.ts, and a static edge from here to the pipeline
// puts pdf-parse/pdfjs-dist into that route's bundle, where webpack's transform
// breaks it ("Object.defineProperty called on non-object") and the route fails
// to compile. The consumer half loads the pipeline dynamically, inside the job
// processor, so only a process that actually runs jobs ever resolves it.

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
import {
  DOCUMENT_INGESTION_QUEUE_NAME,
  type ParsedInboundDocumentEvent,
} from "@/lib/domain/whatsapp/types";
import { isAbortError } from "@/lib/core/http/fetchWithTimeout";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import { releaseWhatsAppMessageClaim } from "@/lib/core/redis";
import { markMessageReadAndTyping } from "@/lib/domain/whatsapp/client";

// -------------------------------------------------------------------------
// Queue
// -------------------------------------------------------------------------

/**
 * Lower than the chat queue's 5. An ingestion attempt costs a media download,
 * a full parse, and an embedding run over every chunk; five of those against a
 * genuinely broken document is a large, pointless bill.
 */
const DEFAULT_JOB_ATTEMPTS = 3;
/** Wider than the chat queue's 2s: the usual cause of a retry here is provider throttling. */
const DEFAULT_BACKOFF_MS = 5_000;

let ingestionQueue: Queue<ParsedInboundDocumentEvent> | null = null;

function getDocumentIngestionQueue(): Queue<ParsedInboundDocumentEvent> {
  if (!ingestionQueue) {
    ingestionQueue = new Queue<ParsedInboundDocumentEvent>(DOCUMENT_INGESTION_QUEUE_NAME, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: parsePositiveInt(
          process.env.DOCUMENT_INGESTION_JOB_ATTEMPTS,
          DEFAULT_JOB_ATTEMPTS
        ),
        backoff: { type: "exponential", delay: DEFAULT_BACKOFF_MS },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
  }
  return ingestionQueue;
}

/**
 * BullMQ rejects custom job ids containing a colon — it is the separator in the
 * Redis key layout, and `Queue.add` throws `Custom Id cannot contain :`.
 *
 * That rule applies to the whole id, prefix included. This shipped broken
 * because it sanitised the vendor id and then prefixed it with `doc:`, so every
 * document enqueue threw, the webhook answered 503, and Meta retried the
 * delivery until it gave up. The underscore separator is the entire fix; the
 * regression test in documentIngestionQueue.test.ts pins it.
 */
export function documentIngestionJobId(messageId: string): string {
  return `doc_${messageId.replace(/:/g, "_")}`;
}

/**
 * A second line of defence behind the Redis idempotency claim in the webhook
 * route: while the completed job is still retained, BullMQ refuses a job with
 * the same id, so a Meta redelivery that slips past an expired claim cannot
 * re-ingest the same document.
 */
export async function enqueueDocumentIngestion(
  event: ParsedInboundDocumentEvent
): Promise<string> {
  const job = await getDocumentIngestionQueue().add("ingest-document", event, {
    jobId: event.messageId ? documentIngestionJobId(event.messageId) : undefined,
  });
  return job.id ?? String(job.name);
}

export async function closeDocumentIngestionQueue(): Promise<void> {
  if (!ingestionQueue) return;
  const queue = ingestionQueue;
  ingestionQueue = null;
  await queue.close();
}

// -------------------------------------------------------------------------
// Worker
// -------------------------------------------------------------------------

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

        // Loaded here rather than at module scope: see the note at the top of
        // this file. Node caches the module, so only the first job on this
        // process pays for resolving it.
        const { processDocumentIngestion } = await import("@/lib/domain/ingestion/pipeline");

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
