// Embeddings via Google AI Studio's free `text-embedding-004` endpoint.
// Output dimensionality is 768; the knowledge_base.embedding column must match.
//
// TODO: Update the knowledge_base schema to vector(768) if it was created with
//       a different dimension. The proposal currently shows vector(1536).

interface GeminiEmbeddingResponse {
  embedding?: {
    values?: number[];
  };
}

interface GeminiBatchEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>;
}

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "text-embedding-004";
const EMBEDDING_DIMENSION = 768;

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
      throw new Error(`Batch embed HTTP ${response.status}`);
    }

    const json = (await response.json()) as GeminiBatchEmbeddingResponse;
    const vectors = json.embeddings ?? [];
    if (vectors.length !== filtered.length) {
      throw new Error(
        `Batch embed returned ${vectors.length} vectors, expected ${filtered.length}.`
      );
    }
    return vectors.map((v) => v.values ?? []);
  } catch (err) {
    // TODO: Replace this fallback with a proper retry/backoff strategy and
    //       observability hook once a logger is wired in.
    console.warn("Batch embed failed, falling back to sequential:", err);
    const out: number[][] = [];
    for (const t of filtered) {
      out.push(await embedText(t));
    }
    return out;
  }
}
