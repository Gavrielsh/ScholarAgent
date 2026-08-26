import { fetchTextWithTimeout, parseJsonBody } from "@/lib/core/http/fetchWithTimeout";
import type { GenerateTextInput, LlmAdapter } from "@/lib/domain/chat/llm/types";

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class OpenAiAdapter implements LlmAdapter {
  async generateText(input: GenerateTextInput): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // TODO: Inject OPENAI_API_KEY for production usage.
      throw new Error("Missing OPENAI_API_KEY environment variable.");
    }

    const model = input.model ?? "gpt-4o-mini";
    const label = `OpenAI(${model})`;

    const response = await fetchTextWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
      }),
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      label,
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${response.body}`);
    }

    const json = parseJsonBody<OpenAiChatCompletionResponse>(response.body, label);
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }
}
