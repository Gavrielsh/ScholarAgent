import { logWarn } from "@/lib/logger";

// Embeddings via Google AI Studio (Gemini embedding models).
interface GeminiEmbeddingResponse {
  embedding?: {
    values?: number[];
  };
}

interface GeminiBatchEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
}

const EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
const EMBEDDING_DIMENSION = 768;

// Aggressive exponential backoff delays to prevent 429 Rate Limit crashes
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function endpoint(path: string): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:${path}?key=${apiKey}`;
}

export async function embedText(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const response = await fetch(endpoint("embedContent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: trimmed }] },
          outputDimensionality: EMBEDDING_DIMENSION, 
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        // Specifically catch 429 Too Many Requests to trigger the retry logic
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Rate limit hit: ${response.status} ${body}`);
        }
        throw new Error(`Gemini embedding failed: ${response.status} ${body}`);
      }

      const json = (await response.json()) as GeminiEmbeddingResponse;
      const values = json.embedding?.values ?? [];
      if (values.length > 0 && values.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Gemini embedding dimension mismatch: got ${values.length}, expected ${EMBEDDING_DIMENSION}.`
        );
      }
      return values;
    } catch (error: any) {
      if (attempt < RETRY_DELAYS_MS.length && (error.message.includes("Rate limit") || error.message.includes("429"))) {
        console.warn(`[RATE LIMIT] Gemini embedText hit 429. Retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Failed to embed text after maximum retries.");
}

export async function embedTextBatch(texts: string[]): Promise<number[][]> {
  const filtered = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (filtered.length === 0) return [];

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const response = await fetch(endpoint("batchEmbedContents"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: filtered.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSION, 
          })),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Batch Rate limit hit: ${response.status} ${body}`);
        }
        throw new Error(`Batch embed HTTP ${response.status} ${body}`);
      }

      const json = (await response.json()) as GeminiBatchEmbeddingResponse;
      const vectors = json.embeddings ?? [];
      if (vectors.length !== filtered.length) {
        throw new Error(
          `Batch embed returned ${vectors.length} vectors, expected ${filtered.length}.`
        );
      }
      return vectors.map((v) => {
        const values = v.values ?? [];
        if (values.length > 0 && values.length !== EMBEDDING_DIMENSION) {
          throw new Error(
            `Gemini embedding dimension mismatch: got ${values.length}, expected ${EMBEDDING_DIMENSION}.`
          );
        }
        return values;
      });
    } catch (err: any) {
      if (attempt < RETRY_DELAYS_MS.length && (err.message.includes("Rate limit") || err.message.includes("429"))) {
        console.warn(`[RATE LIMIT] Gemini batch embed hit 429. Retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      
      logWarn(
        "embed_text_batch_fallback_sequential",
        err instanceof Error ? err.message : String(err),
        { stack: err instanceof Error ? err.stack : undefined }
      );
      break; 
    }
  }

  // Fallback: execute sequentially if batch fails completely (now protected by the delay inside embedText)
  try {
    const out: number[][] = [];
    for (const t of filtered) {
      out.push(await embedText(t)); 
    }
    return out;
  } catch (err) {
    logWarn(
      "embed_text_batch_sequential_failed",
      err instanceof Error ? err.message : String(err),
      { stack: err instanceof Error ? err.stack : undefined }
    );
    throw err;
  }
}