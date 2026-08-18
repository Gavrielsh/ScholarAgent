import { Queue } from "bullmq";

import { getQueueConnection } from "@/lib/queue/connection";
import { parsePositiveInt } from "@/lib/queue/jobRuntime";
import type { ParsedInboundEvent } from "@/lib/whatsapp/types";
import { WHATSAPP_INCOMING_QUEUE_NAME } from "@/lib/whatsapp/types";

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
