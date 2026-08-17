import { Queue } from "bullmq";

import { getQueueConnection } from "@/lib/queue/connection";
import { parsePositiveInt } from "@/lib/queue/jobRuntime";
import type { ParsedInboundDocumentEvent } from "@/lib/whatsapp/types";
import { DOCUMENT_INGESTION_QUEUE_NAME } from "@/lib/whatsapp/types";

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
 * BullMQ rejects custom job ids containing a colon (it is the key separator in
 * Redis). Meta's `wamid.…` ids do not currently use one, but the id is vendor
 * data and normalising it is cheaper than debugging a silent enqueue failure.
 */
function toJobId(messageId: string): string {
  return `doc:${messageId.replace(/:/g, "_")}`;
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
    jobId: event.messageId ? toJobId(event.messageId) : undefined,
  });
  return job.id ?? String(job.name);
}

export async function closeDocumentIngestionQueue(): Promise<void> {
  if (!ingestionQueue) return;
  const queue = ingestionQueue;
  ingestionQueue = null;
  await queue.close();
}
