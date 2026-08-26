import { fetchTextWithTimeout, parseJsonBody } from "@/lib/core/http/fetchWithTimeout";
import type { GenerateTextInput, LlmAdapter } from "@/lib/domain/chat/llm/types";

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
// Gemini enforces strict user→model alternation and rejects empty text parts.
// This function merges consecutive same-role turns and guards every edge case.
function buildGeminiContents(input: GenerateTextInput): {
  systemInstruction: string | null;
  contents: GeminiContent[];
} {
  const systemParts = input.messages.filter((m) => m.role === "system");
  const nonSystemMessages = input.messages.filter((m) => m.role !== "system");

  const systemInstruction =
    systemParts.length > 0 ? systemParts.map((m) => m.content).join("\n") : null;

  const contents: GeminiContent[] = [];

  for (const m of nonSystemMessages) {
    const geminiRole: "user" | "model" = m.role === "assistant" ? "model" : "user";

    // Gemini rejects empty text parts with a 400; substitute a safe placeholder.
    const safeContent =
      m.content.trim() === "" ? "[Empty message / No context]" : m.content;

    const last = contents[contents.length - 1];
    if (last && last.role === geminiRole) {
      // Merge consecutive same-role turns — Gemini requires strict alternation.
      last.parts.push({ text: safeContent });
    } else {
      contents.push({ role: geminiRole, parts: [{ text: safeContent }] });
    }
  }

  // Gemini requires the conversation to start with a user turn.
  if (contents.length > 0 && contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "[Conversation Start]" }] });
  }

  return { systemInstruction, contents };
}

export class GeminiAdapter implements LlmAdapter {
  async generateText(input: GenerateTextInput): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing GEMINI_API_KEY environment variable.");
    }
    const model = input.model ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
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

    if (input.responseSchema) {
      payload.generationConfig = {
        ...(payload.generationConfig as Record<string, unknown>),
        response_mime_type: "application/json",
        response_schema: input.responseSchema,
      };
    }

    // `label` is mandatory here: the endpoint carries ?key=<GEMINI_API_KEY>, and
    // the default label would otherwise put a live credential into error strings.
    const label = `Gemini(${model})`;

    const response = await fetchTextWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      label,
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed: ${response.status} ${response.body}`);
    }

    const json = parseJsonBody<GeminiResponse>(response.body, label);
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }
}
