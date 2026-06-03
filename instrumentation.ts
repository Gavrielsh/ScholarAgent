export async function register() {
// Check if the worker is running in a Node.js environment
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { createWhatsAppIncomingWorker } = await import(
        "./lib/queue/workers/whatsappIncomingWorker"
      );
      
      createWhatsAppIncomingWorker();
      console.log("🚀 WhatsApp BullMQ Worker started successfully and is listening to Redis!");
    }
  }