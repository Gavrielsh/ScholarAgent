export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** JSON-schema fragment for providers that support structured output natively. */
export type ResponseSchema = Record<string, unknown>;

export interface GenerateTextInput {
  messages: LlmMessage[];
  temperature?: number;
  model?: string;
  responseSchema?: ResponseSchema;
  /**
   * Cancellation from the surrounding unit of work (BullMQ job deadline,
   * worker shutdown). Providers must forward this to their HTTP call so a
   * cancelled job stops paying for tokens it will never deliver.
   */
  signal?: AbortSignal | null;
  /** Per-call override of the default 15s HTTP deadline. */
  timeoutMs?: number;
}

export interface LlmAdapter {
  generateText(input: GenerateTextInput): Promise<string>;
}
