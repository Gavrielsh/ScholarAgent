/**
 * Sole consumer of the `whatsapp-incoming` and `document-ingestion` queues.
 *
 * Next.js is a producer only (see instrumentation.ts). Run this as its own
 * process/container: `npm run worker:whatsapp`.
 *
 * The two queues share this process but not their settings: chat jobs are short
 * and highly concurrent, ingestion jobs are long, memory-heavy, and rate limited
 * against the embedding quota. Keeping them in separate BullMQ queues is what
 * stops one uploaded PDF from occupying the concurrency slots that conversations
 * need.
 */

import type { Worker } from "bullmq";

import { closePool } from "@/lib/core/db";
import { closeRedisClient } from "@/lib/core/redis";
import {
  closeDocumentIngestionQueue,
  createDocumentIngestionWorker,
} from "@/lib/domain/ingestion/worker";
import {
  closeWhatsAppIncomingQueue,
  createWhatsAppIncomingWorker,
  getWhatsAppIncomingQueue,
} from "@/lib/domain/whatsapp/worker";
import { logError, logInfo, logWarn } from "@/lib/core/logger";

if (!process.env.WHATSAPP_ACCESS_TOKEN?.trim() || !process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()) {
  logError(
    "whatsapp_worker_missing_credentials",
    new Error("WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set")
  );
  process.exit(1);
}

/**
 * How long in-flight jobs get to finish after a signal arrives.
 *
 * Must stay below the orchestrator's kill grace period, or the platform sends
 * SIGKILL mid-drain and the work is lost anyway. Docker Compose and Kubernetes
 * both default to 30s, so this defaults to 25s to leave room for the Redis and
 * Postgres teardown that follows.
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 25_000);

/** Absolute ceiling. If the graceful path itself wedges, exit anyway. */
const FORCE_EXIT_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS + 5_000;

const chatWorker: Worker = createWhatsAppIncomingWorker();
const documentWorker: Worker = createDocumentIngestionWorker();

logInfo("whatsapp_worker_started", "WhatsApp queue consumers are running.", {
  queues: [chatWorker.name, documentWorker.name],
  pid: process.pid,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
});

void (async () => {
  try {
    const peers = await getWhatsAppIncomingQueue().getWorkers();
    if (peers.length > 1) {
      logWarn(
        "whatsapp_worker_duplicate_consumer",
        "More than one process is consuming whatsapp-incoming; jobs will be split between them.",
        { consumerCount: peers.length, addresses: peers.map((peer) => peer.addr ?? "") }
      );
    }
  } catch (err) {
    logWarn(
      "whatsapp_worker_consumer_check_failed",
      err instanceof Error ? err.message : String(err)
    );
  }
})();

/**
 * Guards against re-entry. Orchestrators routinely send SIGTERM and then SIGINT
 * a moment later; running the sequence twice would call `close()` on an already
 * closing worker and throw during teardown, masking the original exit code.
 */
let shuttingDown = false;

/** Rejects if `task` outruns `ms`, so one hung step cannot block the rest. */
async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms.`)), ms);
    timer.unref?.();
  });

  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a teardown step without letting its failure abort the ones after it.
 *
 * Ordering matters more than success here: if closing the queue throws, we still
 * need to close Redis and Postgres or the process leaks sockets and hangs on a
 * non-empty event loop instead of exiting.
 */
async function closeQuietly(label: string, close: () => Promise<void>): Promise<boolean> {
  try {
    await withTimeout(close(), SHUTDOWN_TIMEOUT_MS, label);
    logInfo("whatsapp_worker_shutdown_step", `${label} closed.`);
    return true;
  } catch (err) {
    logError("whatsapp_worker_shutdown_step_failed", err, { step: label });
    return false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logWarn("whatsapp_worker_shutdown_repeat", `Ignoring ${signal}; shutdown already running.`);
    return;
  }
  shuttingDown = true;

  logInfo("whatsapp_worker_shutdown", `Received ${signal}, draining.`, {
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  // Last-resort watchdog, armed before any awaiting begins. unref'd so it never
  // by itself keeps the process alive once a clean exit is reachable.
  const forceExit = setTimeout(() => {
    logError(
      "whatsapp_worker_shutdown_forced",
      new Error(`Graceful shutdown exceeded ${FORCE_EXIT_TIMEOUT_MS}ms; forcing exit.`)
    );
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
  forceExit.unref?.();

  // ── 1. Stop accepting new jobs and wait for active ones ───────────────────
  // `worker.close()` (force = false) stops the fetch loop immediately and then
  // waits for handlers already running. Anything still in flight when the
  // timeout fires stays in the queue with an expired lock and is retried by
  // another instance — safe, because both pipelines are idempotent on the Meta
  // message id (migration 006 for chat, migration 007 for documents) and the
  // Redis claim survives.
  //
  // Drained in parallel: run sequentially, a long ingestion job could consume
  // the entire grace period and leave the chat worker to be SIGKILLed mid-turn.
  const [chatDrained, documentsDrained] = await Promise.all([
    closeQuietly("bullmq_worker_chat", () => chatWorker.close()),
    closeQuietly("bullmq_worker_documents", () => documentWorker.close()),
  ]);
  const drained = chatDrained && documentsDrained;
  if (!drained) {
    logWarn(
      "whatsapp_worker_drain_incomplete",
      "Active jobs did not finish in time; they will be retried after their lock expires.",
      { chatDrained, documentsDrained }
    );
  }

  // ── 2. Release infrastructure, queues first ───────────────────────────────
  // Each queue holds its own Redis connection, separate from the idempotency
  // client, so all of them must be closed and the shared client must go last.
  const results = [
    await closeQuietly("bullmq_queue_chat", closeWhatsAppIncomingQueue),
    await closeQuietly("bullmq_queue_documents", closeDocumentIngestionQueue),
    await closeQuietly("redis", closeRedisClient),
    await closeQuietly("postgres", closePool),
  ];

  clearTimeout(forceExit);

  const clean = drained && results.every(Boolean);
  logInfo("whatsapp_worker_shutdown_complete", "Shutdown finished.", { clean });

  // Explicit exit: a lingering undici socket or ioredis reconnect timer can keep
  // the loop alive indefinitely, and the platform would then SIGKILL us and
  // report a failed shutdown despite a clean drain.
  process.exit(clean ? 0 : 1);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * A crash mid-job would otherwise abandon the BullMQ lock and leave connections
 * open. Drain through the same path so the job is released promptly, then exit
 * non-zero and let the supervisor restart a clean process.
 */
process.on("uncaughtException", (err) => {
  logError("whatsapp_worker_uncaught_exception", err);
  process.exitCode = 1;
  void shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logError("whatsapp_worker_unhandled_rejection", reason);
  process.exitCode = 1;
  void shutdown("unhandledRejection");
});
