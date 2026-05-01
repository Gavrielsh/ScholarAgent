import { GeminiAdapter } from "@/lib/llm/providers/gemini";
import { LlamaAdapter } from "@/lib/llm/providers/llama";
import { MockLlmAdapter } from "@/lib/llm/providers/mock";
import { OpenAiAdapter } from "@/lib/llm/providers/openai";
import type { LlmAdapter } from "@/lib/llm/types";

export function getLlmAdapter(): LlmAdapter {
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  switch (provider) {
    case "openai":
      return new OpenAiAdapter();
    case "gemini":
      return new GeminiAdapter();
    case "llama":
      return new LlamaAdapter();
    case "mock":
    default:
      return new MockLlmAdapter();
  }
}
