import type { GenerateTextInput, LlmAdapter } from "@/lib/llm/types";

export class MockLlmAdapter implements LlmAdapter {
  async generateText(input: GenerateTextInput): Promise<string> {
    const lastUserMessage = [...input.messages].reverse().find((m) => m.role === "user");
    const mission = lastUserMessage?.content ?? "No mission found.";

    // TODO: Replace this deterministic mock once real provider is configured.
    return [
      "Decision-Support Draft:",
      mission.slice(0, 500),
      "",
      "This is a mock LLM response. Switch LLM_PROVIDER to `openai` to enable real generation.",
    ].join("\n");
  }
}
