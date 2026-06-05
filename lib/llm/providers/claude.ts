import type { GenerateTextInput, LlmAdapter } from "@/lib/llm/types";

// Claude adapter — Anthropic Messages API (thesis comparison: commercial closed-source LLM).
// Uses raw fetch to match the pattern of all other providers in this codebase.
// Docs: https://docs.anthropic.com/en/api/messages

const DEFAULT_MODEL = "claude-sonnet-4-6";
/** Lightweight model for fast intent-classification calls. */
const DEFAULT_FAST_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponseContent {
  type: string;
  text?: string;
}

interface AnthropicErrorBody {
  error?: {
    type?: string;
    message?: string;
  };
}

interface AnthropicResponse {
  content?: AnthropicResponseContent[];
  error?: { type: string; message: string };
}

/**
 * Separates system-role messages (Anthropic top-level `system` param) from
 * the conversational turns (Anthropic `messages` array, roles user|assistant only).
 */
function buildAnthropicPayload(
  input: GenerateTextInput,
  model: string
): Record<string, unknown> {
  const systemParts = input.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content);

  const conversationMessages: AnthropicRequestMessage[] = input.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const maxTokens = parseInt(process.env.CLAUDE_MAX_TOKENS ?? "4096", 10);

  const payload: Record<string, unknown> = {
    model,
    messages: conversationMessages,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
    temperature: input.temperature ?? 0.2,
  };

  if (systemParts.length > 0) {
    let systemText = systemParts.join("\n");
    // When the caller requests structured JSON output, reinforce the format in
    // the system prompt since the Anthropic API does not accept a response_schema
    // parameter directly (unlike Gemini).
    if (input.responseSchema) {
      systemText +=
        "\n\nIMPORTANT: Your response MUST be valid JSON only — no prose, no markdown fences.";
    }
    payload.system = systemText;
  }

  return payload;
}

/**
 * Parses Anthropic's JSON error body and returns a human-readable detail string.
 * Falls back to the raw text if the body is not valid JSON.
 */
function parseAnthropicError(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as AnthropicErrorBody;
    const { type, message } = parsed.error ?? {};
    if (message) {
      return type ? `[${type}] ${message}` : message;
    }
  } catch {
    // body is plain text — use as-is
  }
  return bodyText;
}

export class ClaudeAdapter implements LlmAdapter {
  async generateText(input: GenerateTextInput): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Missing ANTHROPIC_API_KEY environment variable. " +
          "Set it before using the Claude provider."
      );
    }

    // Resolve the incoming model parameter to an official Anthropic model string.
    let modelRequested =
      input.model?.trim() ?? process.env.CLAUDE_MODEL?.trim() ?? DEFAULT_MODEL;

    // Normalize generic aliases used by evaluation runners or configs.
    const lower = modelRequested.toLowerCase();
    if (lower === "claude" || lower === "claude-3-5-sonnet") {
      modelRequested = DEFAULT_MODEL;
    } else if (lower === "claude-fast" || lower === "claude-3-haiku") {
      modelRequested = DEFAULT_FAST_MODEL;
    }

    const payload = buildAnthropicPayload(input, modelRequested);

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const detail = parseAnthropicError(bodyText);
      throw new Error(
        `Anthropic Claude request failed: HTTP ${response.status} | model="${modelRequested}" | ${detail}`
      );
    }

    const json = (await response.json()) as AnthropicResponse;

    const text =
      json.content?.find((c) => c.type === "text")?.text?.trim() ?? "";

    return text;
  }
}

/** Exported so intentRouter can reference it without re-reading env. */
export const CLAUDE_FAST_MODEL =
  process.env.CLAUDE_FAST_MODEL?.trim() ?? DEFAULT_FAST_MODEL;
