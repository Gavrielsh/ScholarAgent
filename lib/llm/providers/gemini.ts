import type { GenerateTextInput, LlmAdapter } from "@/lib/llm/types";

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

// Maps our internal roles to Gemini's role format.
// Gemini only supports "user" and "model" roles; system messages are prepended to the first user turn.
function buildGeminiContents(input: GenerateTextInput): {
  systemInstruction: string | null;
  contents: GeminiContent[];
} {
  const systemParts = input.messages.filter((m) => m.role === "system");
  const nonSystemMessages = input.messages.filter((m) => m.role !== "system");

  const systemInstruction =
    systemParts.length > 0 ? systemParts.map((m) => m.content).join("\n") : null;

  const contents: GeminiContent[] = nonSystemMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  return { systemInstruction, contents };
}

export class GeminiAdapter implements LlmAdapter {
  async generateText(input: GenerateTextInput): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing GEMINI_API_KEY environment variable.");
    }

    const model = process.env.GEMINI_MODEL ?? "gemini-1.5-pro";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const { systemInstruction, contents } = buildGeminiContents(input);

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: input.temperature ?? 0.2,
      },
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini request failed: ${response.status} ${body}`);
    }

    const json = (await response.json()) as GeminiResponse;
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }
}
