import type { GenerateTextInput, LlmAdapter } from "@/lib/llm/types";

// Llama 3 adapter — second LLM in the thesis comparison (H2: higher speed, lower faithfulness).
// Targets a locally-hosted Ollama instance or a compatible OpenAI-format endpoint.
// Set LLAMA_BASE_URL to override the default Ollama address.

interface OllamaResponse {
  message?: {
    content?: string;
  };
}

export class LlamaAdapter implements LlmAdapter {
  async generateText(input: GenerateTextInput): Promise<string> {
    const baseUrl = process.env.LLAMA_BASE_URL ?? "http://localhost:11434";
    const model = process.env.LLAMA_MODEL ?? "llama3";
    const endpoint = `${baseUrl}/api/chat`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: input.messages,
        stream: false,
        options: {
          temperature: input.temperature ?? 0.2,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Llama (Ollama) request failed: ${response.status} ${body}`);
    }

    const json = (await response.json()) as OllamaResponse;
    return json.message?.content?.trim() ?? "";
  }
}
