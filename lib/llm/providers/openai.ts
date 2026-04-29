import type { GenerateTextInput, LlmAdapter } from "@/lib/llm/types";

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

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // TODO: Tune model choice and token limits for production.
        model: "gpt-4o-mini",
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${body}`);
    }

    const json = (await response.json()) as OpenAiChatCompletionResponse;
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }
}
