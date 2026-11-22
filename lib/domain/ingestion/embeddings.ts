import {
  abortableSleep,
  fetchTextWithTimeout,
  isAbortError,
  isHttpAbortedError,
  isHttpTimeoutError,
  parseJsonBody,
} from "@/lib/core/http/fetchWithTimeout";
import { logWarn } from "@/lib/core/logger";
import { parsePositiveInt } from "@/lib/core/env";

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

/** Never used in an error string — see `EMBEDDING_LABEL`. */
const EMBEDDING_TIMEOUT_MS = parsePositiveInt(process.env.EMBEDDING_TIMEOUT_MS, 15_000);
/** Batch calls carry up to `MAX_BATCH_SIZE` documents, so they get a wider budget. */
const EMBEDDING_BATCH_TIMEOUT_MS = parsePositiveInt(
  process.env.EMBEDDING_BATCH_TIMEOUT_MS,
  45_000
);
const EMBEDDING_LABEL = `GeminiEmbeddings(${EMBEDDING_MODEL})`;

// Aggressive exponential backoff delays to prevent 429 Rate Limit crashes
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000] as const;

/**
 * Bounded LRU cache. Query embeddings are cached alongside document chunks, and
 * the worker process is long-lived, so an unbounded Map would grow by one
 * 768-float vector for every distinct user question until the container OOMs.
 * Map preserves insertion order, which is all an approximate LRU needs.
 */
const EMBEDDING_CACHE_MAX_ENTRIES = parsePositiveInt(process.env.EMBEDDING_CACHE_MAX, 5_000);
const embeddingCache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const hit = embeddingCache.get(key);
  if (hit === undefined) return undefined;
  // Re-insert to mark as most-recently-used.
  embeddingCache.delete(key);
  embeddingCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: number[]): void {
  // Never cache a degenerate vector: doing so permanently poisons this key for
  // the life of the process, and every later caller would throw on insert
  // because an empty vector cannot be serialised to a pgvector literal.
  if (value.length !== EMBEDDING_DIMENSION) return;

  if (embeddingCache.has(key)) embeddingCache.delete(key);
  embeddingCache.set(key, value);

  while (embeddingCache.size > EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldest = embeddingCache.keys().next();
    if (oldest.done) break;
    embeddingCache.delete(oldest.value);
  }
}

// -------------------------------------------------------------------------
// Deterministic offline provider
// -------------------------------------------------------------------------

/**
 * Opt-in offline embedding provider, for CI.
 *
 * `LLM_PROVIDER=mock` only swaps the *chat* adapter in lib/domain/chat/llm.ts;
 * embeddings still went to Google, so `npm run ingest` and `npm run eval:seed`
 * could not run without `GEMINI_API_KEY`. The CI security gate needs them to
 * run hermetically, hence this.
 *
 * ## Why a mock does not weaken the RLS gate
 *
 * `scripts/seed_eval_canaries.ts` probes each canary with `embedText` over the
 * canary's OWN content, so the query vector is bit-identical to the stored one:
 * cosine distance 0, rank 1, for any embedding function that is deterministic.
 * The positive control therefore still proves reachability, and the negative
 * control is a pure policy question that never involved the vector at all.
 *
 * It is NOT a substitute for real embeddings in the thesis experiments —
 * semantic neighbourhoods here are meaningless, so recall/NDCG measured under
 * it would be noise. Read at call time, never cached at module scope, and
 * defaults off, so no production path can reach it without being told to.
 */
function embeddingProvider(): string {
  return (process.env.EMBEDDING_PROVIDER ?? "gemini").trim().toLowerCase();
}

export function isMockEmbeddingProvider(): boolean {
  return embeddingProvider() === "mock";
}

/** FNV-1a — a small, well-defined string hash. Not cryptographic by design. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic unit vector derived from the text.
 *
 * Same text in, same vector out, across processes and runs — that is the only
 * property the eval gate depends on. L2-normalised and seeded away from zero so
 * it is always a legal pgvector cosine operand.
 *
 * Exported for the test that pins determinism and dimension.
 */
export function mockEmbedding(text: string): number[] {
  // xorshift32 seeded from the text; `|| 1` because a zero seed is a fixed
  // point of xorshift and would emit an all-zero vector.
  let state = fnv1a(text.trim()) || 1;
  const out = new Array<number>(EMBEDDING_DIMENSION);
  let sumSquares = 0;

  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    // Map to [-1, 1).
    const value = state / 0x80000000 - 1;
    out[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    // Unreachable with a non-zero seed; a uniform unit vector is still legal.
    return new Array<number>(EMBEDDING_DIMENSION).fill(1 / Math.sqrt(EMBEDDING_DIMENSION));
  }
  return out.map((v) => v / norm);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Retry only what a retry can fix: provider throttling, 5xx, and our own
 * timeout. A 400 (bad dimension, malformed payload) is deterministic — retrying
 * it five times just burns 62s of backoff before failing identically.
 */
function isRetryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || isAbortError(err) || isHttpAbortedError(err)) return false;
  if (isHttpTimeoutError(err)) return true;
  const message = errorMessage(err);
  return message.includes("Rate limit") || message.includes("429");
}

function endpoint(path: string): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:${path}?key=${apiKey}`;
}

export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (signal?.aborted) {
    throw new Error("Embedding cancelled before completion.");
  }

  // Before the cache: deterministic, so there is nothing to amortise, and this
  // keeps the mock out of the cache the real provider shares.
  if (isMockEmbeddingProvider()) return mockEmbedding(trimmed);

  const cached = cacheGet(trimmed);
  if (cached) return cached;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const response = await fetchTextWithTimeout(endpoint("embedContent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: trimmed }] },
          outputDimensionality: EMBEDDING_DIMENSION,
        }),
        timeoutMs: EMBEDDING_TIMEOUT_MS,
        label: EMBEDDING_LABEL,
        signal,
      });

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Rate limit hit: ${response.status} ${response.body}`);
        }
        throw new Error(`Gemini embedding failed: ${response.status} ${response.body}`);
      }

      const json = parseJsonBody<GeminiEmbeddingResponse>(response.body, EMBEDDING_LABEL);
      const values = json.embedding?.values ?? [];
      if (values.length > 0 && values.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Gemini embedding dimension mismatch: got ${values.length}, expected ${EMBEDDING_DIMENSION}.`
        );
      }

      cacheSet(trimmed, values);
      return values;
    } catch (err: unknown) {
      if (attempt < RETRY_DELAYS_MS.length && isRetryable(err, signal)) {
        logWarn("embed_text_retry", errorMessage(err), {
          attempt: attempt + 1,
          delayMs: RETRY_DELAYS_MS[attempt],
          timedOut: isHttpTimeoutError(err),
        });
        await abortableSleep(RETRY_DELAYS_MS[attempt], signal);
        if (signal?.aborted) {
          throw err;
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to embed text after maximum retries.");
}

/**
 * Embeds every input and returns vectors **index-aligned with `texts`**.
 *
 * The previous implementation filtered blanks and then mapped over the filtered
 * array, so a single empty string shifted every subsequent vector by one and
 * silently attached the wrong embedding to the wrong chunk. Callers
 * (`uploader.ts`, `insertDocumentWithChunks`) only length-check the result, which
 * would not catch that. Blanks are now rejected up front so the alignment
 * contract is total.
 */
export async function embedTextBatch(
  texts: string[],
  signal?: AbortSignal
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (signal?.aborted) {
    throw new Error("Embedding cancelled before completion.");
  }

  const normalized = texts.map((t) => t.trim());
  const blankIndex = normalized.findIndex((t) => t.length === 0);
  if (blankIndex !== -1) {
    throw new Error(
      `embedTextBatch received a blank input at index ${blankIndex}; ` +
        "filter empty chunks before embedding to keep vectors index-aligned."
    );
  }

  // After the blank check, so the mock enforces the same index-alignment
  // contract the real provider does rather than hiding a caller's bug in CI.
  if (isMockEmbeddingProvider()) return normalized.map((t) => mockEmbedding(t));

  // De-duplicate before hitting the API: repeated boilerplate (headers, footers)
  // is common across chunks of the same document.
  const missingTexts = [...new Set(normalized.filter((text) => !embeddingCache.has(text)))];

  if (missingTexts.length > 0) {
    let batchSuccess = false;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        const response = await fetchTextWithTimeout(endpoint("batchEmbedContents"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: missingTexts.map((text) => ({
              model: `models/${EMBEDDING_MODEL}`,
              content: { parts: [{ text }] },
              outputDimensionality: EMBEDDING_DIMENSION,
            })),
          }),
          timeoutMs: EMBEDDING_BATCH_TIMEOUT_MS,
          label: EMBEDDING_LABEL,
          signal,
        });

        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            throw new Error(`Batch Rate limit hit: ${response.status} ${response.body}`);
          }
          throw new Error(`Batch embed HTTP ${response.status} ${response.body}`);
        }

        const json = parseJsonBody<GeminiBatchEmbeddingResponse>(response.body, EMBEDDING_LABEL);
        const vectors = json.embeddings ?? [];
        if (vectors.length !== missingTexts.length) {
          throw new Error(
            `Batch embed returned ${vectors.length} vectors, expected ${missingTexts.length}.`
          );
        }

        vectors.forEach((v, idx) => {
          const values = v.values ?? [];
          if (values.length > 0 && values.length !== EMBEDDING_DIMENSION) {
            throw new Error(
              `Gemini embedding dimension mismatch: got ${values.length}, expected ${EMBEDDING_DIMENSION}.`
            );
          }
          cacheSet(missingTexts[idx], values);
        });

        batchSuccess = true;
        break;
      } catch (err: unknown) {
        if (attempt < RETRY_DELAYS_MS.length && isRetryable(err, signal)) {
          logWarn("embed_text_batch_retry", errorMessage(err), {
            attempt: attempt + 1,
            delayMs: RETRY_DELAYS_MS[attempt],
            timedOut: isHttpTimeoutError(err),
          });
          await abortableSleep(RETRY_DELAYS_MS[attempt], signal);
          if (signal?.aborted) {
            throw err;
          }
          continue;
        }

        logWarn("embed_text_batch_fallback_sequential", errorMessage(err), {
          stack: err instanceof Error ? err.stack : undefined,
        });
        break;
      }
    }

    // Fallback: execute sequentially if batch fails completely.
    if (!batchSuccess) {
      for (const t of missingTexts) {
        // embedText caches internally, so the reconstruction below still hits.
        await embedText(t, signal);
      }
    }
  }

  // Reconstruct in the caller's order. `normalized` (not `missingTexts`) is the
  // ordered basis, so cache hits and misses interleave correctly.
  return normalized.map((text) => {
    const vector = cacheGet(text);
    if (!vector) {
      // Reachable when the provider returned an empty vector for one input:
      // cacheSet refuses to store it, so fail loudly here rather than handing
      // back an index-shifted array that would mis-assign every later embedding.
      throw new Error(`Embedding missing for a batched input (${text.length} chars).`);
    }
    return vector;
  });
}
