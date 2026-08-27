import { Queue } from "bullmq";

import { getQueueConnection } from "@/lib/core/queue";
import { parsePositiveInt } from "@/lib/core/env";
import {
  DOCUMENT_INGESTION_QUEUE_NAME,
  type ParsedInboundDocumentEvent,
} from "@/lib/domain/whatsapp/types";

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
