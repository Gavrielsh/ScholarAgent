/**
 * Next.js startup hook.
 *
 * This process is a PRODUCER ONLY. It verifies webhook signatures, claims the
 * message id in Redis, enqueues, and ACKs — it must never consume the queue.
 *
 * A `createWhatsAppIncomingWorker()` call used to live here. That was wrong in
 * three separate ways, and none of them are obvious from reading this file:
 *
 *  1. docker-compose runs `app` and `whatsapp-worker` side by side, so the queue
 *     had two consumers and real concurrency was 2x the configured value —
 *     silently doubling load on Postgres and the LLM provider.
 *  2. Only scripts/whatsapp-worker.ts installs signal handlers, so the in-process
 *     worker was SIGKILLed mid-job on every deploy, leaving jobs to stall out.
 *  3. On Vercel this hook runs per lambda instance, spawning a consumer that is
 *     frozen the moment the HTTP response is returned — the job is picked up,
 *     the lock is held, and nothing progresses until it stalls.
 *
 * The worker now runs exclusively in its own process. Start it with
 * `npm run worker:whatsapp`.
 */
export async function register(): Promise<void> {
  // Intentionally empty. Do not start queue consumers, cron loops, or any other
  // background work here — see the note above.
}
