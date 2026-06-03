import { Worker, type Job } from "bullmq";

import { getQueueConnection } from "@/lib/queue/connection";
import { releaseWhatsAppMessageClaim } from "@/lib/redis/idempotency";
import { logError, logInfo } from "@/lib/logger";
import { processIncomingMessage } from "@/lib/whatsapp/incomingMessageProcessor";
import type { ParsedInboundEvent } from "@/lib/whatsapp/types";
import { WHATSAPP_INCOMING_QUEUE_NAME } from "@/lib/whatsapp/types";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_DURATION_MS = 1_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isFinalAttempt(job: Job<ParsedInboundEvent>): boolean {
  const maxAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= maxAttempts;
}

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

  const worker = new Worker<ParsedInboundEvent>(
    WHATSAPP_INCOMING_QUEUE_NAME,
    async (job) => {
      await processIncomingMessage(job.data);
    },
    {
      connection: getQueueConnection(),
      concurrency,
      limiter: {
        max: rateLimitMax,
        duration: rateLimitDurationMs,
      },
    }
  );

  worker.on("completed", (job) => {
    logInfo("whatsapp_queue_job_completed", "Incoming WhatsApp message processed.", {
      jobId: job.id,
      messageId: job.data.messageId,
      senderId: job.data.senderId,
    });
  });

  worker.on("failed", async (job, err) => {
    logError("whatsapp_queue_job_failed", err, {
      jobId: job?.id ?? null,
      messageId: job?.data.messageId ?? null,
      senderId: job?.data.senderId ?? null,
      attemptsMade: job?.attemptsMade ?? null,
    });

    const messageId = job?.data.messageId;
    if (messageId && job && isFinalAttempt(job)) {
      try {
        await releaseWhatsAppMessageClaim(messageId);
      } catch (releaseErr) {
        logError("whatsapp_idempotency_release_failed", releaseErr, { messageId, jobId: job.id });
      }
    }
  });

  return worker;
}
