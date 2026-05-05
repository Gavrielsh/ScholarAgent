export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  // Approximate target size of each chunk in characters.
  // We use characters rather than tokens to avoid a tokeniser dependency;
  // ~4 chars ≈ 1 token for English/Hebrew mixes.
  chunkSize?: number;
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 150;

// Splits a long text into overlapping chunks, preferring sentence/paragraph
// boundaries over arbitrary mid-word cuts. Empty input returns an empty array.
export function chunkText(rawText: string, options: ChunkOptions = {}): Chunk[] {
  const text = rawText.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const chunkSize = Math.max(100, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_OVERLAP, chunkSize - 1));

  const chunks: Chunk[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < text.length) {
    const tentativeEnd = Math.min(cursor + chunkSize, text.length);
    const end = tentativeEnd === text.length ? tentativeEnd : findBoundary(text, cursor, tentativeEnd);

    const slice = text.slice(cursor, end).trim();
    if (slice.length > 0) {
      chunks.push({
        index,
        text: slice,
        charStart: cursor,
        charEnd: end,
      });
      index += 1;
    }

    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }

  return chunks;
}

// Looks backwards from `tentativeEnd` for a natural boundary (paragraph,
// sentence, or whitespace). Falls back to the hard cut if nothing close enough.
function findBoundary(text: string, start: number, tentativeEnd: number): number {
  const window = text.slice(start, tentativeEnd);
  const lookback = Math.min(window.length, 250);
  const tail = window.slice(window.length - lookback);

  const candidates = [
    tail.lastIndexOf("\n\n"),
    tail.lastIndexOf(". "),
    tail.lastIndexOf("! "),
    tail.lastIndexOf("? "),
    tail.lastIndexOf("\n"),
    tail.lastIndexOf(" "),
  ].filter((i) => i > 0);

  if (candidates.length === 0) return tentativeEnd;
  const bestRelative = Math.max(...candidates);
  return start + (window.length - lookback) + bestRelative + 1;
}
