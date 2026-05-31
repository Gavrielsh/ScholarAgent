/** Conversation turn used by Baseline RAG and WhatsApp chat history. */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt?: string;
}
