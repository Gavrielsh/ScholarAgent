export interface EmbeddingRecord {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SimilarDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown> | null;
  similarity: number;
}

/**
 * Create an embedding vector for input text.
 */
export async function embedText(text: string): Promise<number[]> {
  // TODO: Inject provider API key via env var (e.g. OPENAI_API_KEY or ANTHROPIC_API_KEY).
  // TODO: Replace this stub with real embedding model invocation.
  // Example providers: OpenAI text-embedding-3-large, local embeddings, etc.
  if (!text.trim()) {
    return [];
  }
  return [];
}

/**
 * Insert or update a document row in Postgres with pgvector embedding.
 */
export async function upsertDocument(document: EmbeddingRecord): Promise<void> {
  // TODO: Inject Postgres connection URI via env var DATABASE_URL.
  // TODO: Use a real DB client (pg, postgres.js, Prisma with $executeRaw, etc.).
  // Example SQL:
  // INSERT INTO knowledge_base (id, content, metadata, embedding)
  // VALUES ($1, $2, $3::jsonb, $4::vector)
  // ON CONFLICT (id) DO UPDATE
  // SET content = EXCLUDED.content,
  //     metadata = EXCLUDED.metadata,
  //     embedding = EXCLUDED.embedding;
  void document;
}

/**
 * Query nearest documents by vector similarity.
 */
export async function querySimilarDocuments(
  queryText: string,
  limit = 5
): Promise<SimilarDocument[]> {
  // TODO: Inject Postgres connection URI via env var DATABASE_URL.
  // TODO: Generate query embedding from queryText using embedText().
  // TODO: Execute pgvector similarity query with a DB client.
  // Example SQL:
  // SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS similarity
  // FROM knowledge_base
  // ORDER BY embedding <=> $1::vector
  // LIMIT $2;
  void queryText;
  void limit;
  return [];
}
