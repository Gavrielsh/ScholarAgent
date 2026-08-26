// Runtime primitives shared by every BullMQ worker in this repo.
//
// Extracted from whatsappIncomingWorker.ts when the document ingestion worker
// was added: the deadline race, the attempt normalisation, and the env parsing
// are subtle enough (see the comments below) that a second hand-rolled copy
// would drift and reintroduce bugs that were already fixed once.

import { logWarn } from "@/lib/core/logger";

export { parseNonNegativeInt, parsePositiveInt } from "@/lib/core/env/parseEnv";

export class JobTimeoutError extends Error {
  constructor(jobId: string, timeoutMs: number) {
    super(`Job ${jobId} exceeded its ${timeoutMs}ms deadline.`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Thrown when the terminal user-facing notice (apology / ingestion failure)
 * could not be delivered. Processors throw this only on the final attempt so
 * BullMQ marks the job `failed` and the worker can release the Redis claim —
 * swallowing the send error would complete the job and leave the user silent
 * for the claim TTL.
 */
export class TerminalNotifyError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? `Terminal WhatsApp notice failed: ${cause.message}`
        : "Terminal WhatsApp notice failed."
    );
    this.name = "TerminalNotifyError";
    this.cause = cause;
  }
}

/**
 * Normalises BullMQ's attempt counter to a 1-based "current attempt".
 *
 * `attemptsMade` semantics changed across majors: v5 increments it when the job
 * moves to active (so it reads 1 during the first run), earlier versions
 * incremented only on failure (so it read 0). Clamping to a minimum of 1 makes
 * the final-attempt test correct under both, which matters because getting it
 * wrong either suppresses the user's only error message or restores the
 * repeated-apology behaviour the processors exist to prevent.
 *
 * Structurally typed rather than taking `Job<T>` so both workers can pass their
 * own payload type without a cast.
 */
export function currentAttempt(job: { attemptsMade: number }): number {
  return Math.max(1, job.attemptsMade);
}

export function maxAttempts(job: { opts: { attempts?: number } }): number {
  return Math.max(1, job.opts.attempts ?? 1);
}

/**
 * Races a handler against a wall-clock deadline.
 *
 * BullMQ v5 removed the per-job `opts.timeout` that v3 had, so a deadline has to
 * be enforced inside the processor. The AbortController is the important half:
 * without it the losing promise keeps running in the background, still holding
 * sockets and still able to send a WhatsApp reply long after the job "failed".
 *
 * The work promise is retained and sunk after abort so a late rejection cannot
 * become an `unhandledRejection` that tears down the worker process.
 */
export async function runWithDeadline(
  jobId: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(jobId, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  const work = run(controller.signal);

  try {
    await Promise.race([work, deadline]);
  } finally {
    // Always clear the timer and abort: on the success path this releases the
    // handle immediately instead of leaving it pending for the full timeout,
    // and on the failure path it cancels any still-in-flight fetch.
    clearTimeout(timer);
    controller.abort();
    await work.catch((err) => {
      logWarn(
        "job_orphaned_after_deadline",
        err instanceof Error ? err.message : String(err),
        { jobId }
      );
    });
  }
}

/**
 * The BullMQ lock must outlive our own deadline, or a wedged handler is declared
 * *stalled* and duplicated onto another worker instead of failing cleanly here.
 */
export const LOCK_GRACE_MS = 30_000;
