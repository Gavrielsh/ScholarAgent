import { closeRedisClient } from "@/lib/redis/client";
import { closeWhatsAppIncomingQueue } from "@/lib/queue/whatsappIncomingQueue";
import { createWhatsAppIncomingWorker } from "@/lib/queue/workers/whatsappIncomingWorker";
import { logError, logInfo } from "@/lib/logger";

const worker = createWhatsAppIncomingWorker();

logInfo("whatsapp_worker_started", "WhatsApp incoming message worker is running.", {
  queue: worker.name,
});

async function shutdown(signal: string): Promise<void> {
  logInfo("whatsapp_worker_shutdown", `Received ${signal}, closing worker.`);
  try {
    await worker.close();
    await closeWhatsAppIncomingQueue();
    await closeRedisClient();
  } catch (err) {
    logError("whatsapp_worker_shutdown_failed", err);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
