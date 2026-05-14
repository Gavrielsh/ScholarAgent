export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Target size in characters (semantic units are packed up to this budget). */
  chunkSize?: number;
  /** Overlap between consecutive chunks, in characters. */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

// Hebrew end punctuation + Latin sentence ends.
const SENTENCE_SPLIT = /(?<=[.!?\u05C0\u05BE])\s+/u;

function mergeAbbreviationFragments(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const cur = p.trim();
    if (!cur) continue;
    const glued =
      out.length > 0 &&
      cur.length <= 4 &&
      /^[\u0590-\u05FFA-Za-z\u05F4\u05F3.+-]+$/.test(cur);
    if (glued) {
      out[out.length - 1] = `${out[out.length - 1]} ${cur}`.trim();
    } else {
      out.push(cur);
    }
  }
  return out;
}

function splitIntoSemanticUnits(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const para of paragraphs) {
    const rawParts = para.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
    units.push(...mergeAbbreviationFragments(rawParts));
  }
  return units.length > 0 ? units : [text.trim()].filter(Boolean);
}

/**
 * Semantic-ish chunking: paragraph → sentence-like units (Hebrew + Latin aware),
 * then packs units into a character budget with overlap.
 */
export function chunkText(rawText: string, options: ChunkOptions = {}): Chunk[] {
  const text = rawText.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const chunkSize = Math.max(200, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_OVERLAP, chunkSize - 1));

  const units = splitIntoSemanticUnits(text);
  const effectiveUnits = units.length > 0 ? units : [text];

  const chunks: Chunk[] = [];
  let index = 0;
  let virtualCursor = 0;
  let current = "";

  const pushChunk = (body: string) => {
    const slice = body.trim();
    if (!slice) return;
    chunks.push({
      index,
      text: slice,
      charStart: virtualCursor,
      charEnd: virtualCursor + slice.length,
    });
    index += 1;
    virtualCursor += Math.max(1, slice.length - overlap);
  };

  for (const unit of effectiveUnits) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      pushChunk(current);
      current = unit;
      continue;
    }

    // Single unit larger than budget — hard window with overlap on raw characters.
    for (let o = 0; o < unit.length; o += Math.max(1, chunkSize - overlap)) {
      const part = unit.slice(o, o + chunkSize);
      pushChunk(part);
    }
    current = "";
  }

  if (current.trim()) {
    pushChunk(current);
  }

  return chunks;
}
