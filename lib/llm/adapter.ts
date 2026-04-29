import { MockLlmAdapter } from "@/lib/llm/providers/mock";
import { OpenAiAdapter } from "@/lib/llm/providers/openai";
import type { LlmAdapter } from "@/lib/llm/types";

export function getLlmAdapter(): LlmAdapter {
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  switch (provider) {
    case "openai":
      return new OpenAiAdapter();
    case "mock":
    default:
      // TODO: Add Anthropic/Gemini adapters as architecture expands.
      return new MockLlmAdapter();
  }
}
