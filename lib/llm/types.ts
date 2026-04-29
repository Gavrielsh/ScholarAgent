export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateTextInput {
  messages: LlmMessage[];
  temperature?: number;
}

export interface LlmAdapter {
  generateText(input: GenerateTextInput): Promise<string>;
}
