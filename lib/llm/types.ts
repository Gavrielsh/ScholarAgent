export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateTextInput {
  messages: LlmMessage[];
  temperature?: number;
  model?: string;
  responseSchema?: Record<string, any>;
}

export interface LlmAdapter {
  generateText(input: GenerateTextInput): Promise<string>;
}
