// Embeddings via Google AI Studio (Gemini embedding models).
// Default aligns with knowledge_base.vector(768) — multilingual model for Hebrew/Latin corpora.
interface GeminiEmbeddingResponse {
  embedding?: {
    values?: number[];
  };
}

interface GeminiBatchEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
}

// Default: multilingual Gemini embedding (768-dim, aligns with knowledge_base.vector(768)).
// Override via GEMINI_EMBEDDING_MODEL for comparative experiments (e.g. text-embedding-004).
const EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL ?? "text-multilingual-embedding-002";
const EMBEDDING_DIMENSION = 768;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

function endpoint(path: string): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:${path}?key=${apiKey}`;
}

// Generates a single embedding vector for the given text.
export async function embedText(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const response = await fetch(endpoint("embedContent"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: trimmed }] },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
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
}

// Generates embeddings for many texts in one HTTP round-trip.
// Falls back to per-item calls if the batch endpoint is unavailable.
export async function embedTextBatch(texts: string[]): Promise<number[][]> {
  const filtered = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (filtered.length === 0) return [];

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const response = await fetch(endpoint("batchEmbedContents"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: filtered.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
          })),
        }),
      });

      if (!response.ok) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new Error(`Batch embed HTTP ${response.status}`);
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
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      console.warn("Batch embed failed after retries, falling back to sequential:", err);
    }
    break;
  }

  try {
    const out: number[][] = [];
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        for (const t of filtered) {
          out.push(await embedText(t));
        }
        return out;
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          out.length = 0;
          continue;
        }
        throw err;
      }
    }
    return out;
  } catch (err) {
    console.warn("Batch embed failed after retries, sequential fallback also failed:", err);
    throw err;
  }
}
