// LLM provider factory.
//
// All four providers speak raw HTTP through the shared fetchWithTimeout helper —
// this repo depends on no vendor SDK — so merging them costs nothing at import
// time. Every API key is read inside generateText(), never at module scope, and
// getLlmAdapter() constructs exactly one adapter for the configured provider.
// Importing this module therefore reads no credentials and opens no connection.
//
// adapter.ts already imported all four providers statically, so the module graph
// is unchanged by the consolidation.

import { fetchTextWithTimeout, parseJsonBody } from "@/lib/core/http/fetchWithTimeout";

// -------------------------------------------------------------------------
// Shared types
// -------------------------------------------------------------------------

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** JSON-schema fragment for providers that support structured output natively. */
export type ResponseSchema = Record<string, unknown>;

export interface GenerateTextInput {
  messages: LlmMessage[];
  temperature?: number;
  model?: string;
  responseSchema?: ResponseSchema;
  /**
   * Cancellation from the surrounding unit of work (BullMQ job deadline,
   * worker shutdown). Providers must forward this to their HTTP call so a
   * cancelled job stops paying for tokens it will never deliver.
   */
  signal?: AbortSignal | null;
  /** Per-call override of the default 15s HTTP deadline. */
  timeoutMs?: number;
}

export interface LlmAdapter {
  generateText(input: GenerateTextInput): Promise<string>;
}

// -------------------------------------------------------------------------
// Mock provider
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// OpenAI provider
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Gemini provider
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Claude provider
// -------------------------------------------------------------------------

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

    const label = `Anthropic(${modelRequested})`;

    const response = await fetchTextWithTimeout(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      label,
    });

    if (!response.ok) {
      const detail = parseAnthropicError(response.body);
      throw new Error(
        `Anthropic Claude request failed: HTTP ${response.status} | model="${modelRequested}" | ${detail}`
      );
    }

    const json = parseJsonBody<AnthropicResponse>(response.body, label);

    const text =
      json.content?.find((c) => c.type === "text")?.text?.trim() ?? "";

    return text;
  }
}

/** Exported so intentRouter can reference it without re-reading env. */
export const CLAUDE_FAST_MODEL =
  process.env.CLAUDE_FAST_MODEL?.trim() ?? DEFAULT_FAST_MODEL;

// -------------------------------------------------------------------------
// Factory
// -------------------------------------------------------------------------

let cachedAdapter: LlmAdapter | null = null;
let cachedProvider: string | null = null;

function createLlmAdapter(provider: string): LlmAdapter {
  switch (provider) {
    case "openai":
      return new OpenAiAdapter();
    case "gemini":
      return new GeminiAdapter();
    case "claude":
      return new ClaudeAdapter();
    case "mock":
    default:
      return new MockLlmAdapter();
  }
}

/** Returns a module-scoped singleton LLM adapter for the configured provider. */
export function getLlmAdapter(): LlmAdapter {
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  if (cachedAdapter && cachedProvider === provider) {
    return cachedAdapter;
  }

  cachedProvider = provider;
  cachedAdapter = createLlmAdapter(provider);
  return cachedAdapter;
}
