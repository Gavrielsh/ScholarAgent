import { logError } from "@/lib/logger";

/**
 * Runs work after the webhook HTTP response is sent on serverless (Vercel),
 * or awaits it on long-lived Node runtimes (local Docker) where the process
 * does not freeze after the response.
 *
 * Never uses unhandled detached promises (`void (async () => {})()`).
 */
export async function runAfterResponse(task: () => Promise<void>): Promise<void> {
  const guarded = async (): Promise<void> => {
    try {
      await task();
    } catch (err) {
      logError("post_response_task_failed", err);
    }
  };

  if (process.env.VERCEL === "1") {
    try {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(guarded());
      return;
    } catch (err) {
      logError("wait_until_unavailable", err);
    }
  }

  try {
    const nextServer = await import("next/server");
    const afterFn =
      "after" in nextServer && typeof nextServer.after === "function"
        ? nextServer.after
        : "unstable_after" in nextServer &&
            typeof (nextServer as { unstable_after?: (fn: () => Promise<void>) => void }).unstable_after ===
              "function"
          ? (nextServer as { unstable_after: (fn: () => Promise<void>) => void }).unstable_after
          : null;

    if (afterFn) {
      afterFn(guarded);
      return;
    }
  } catch {
    // next/server after not available on this Next.js version
  }

  await guarded();
}
