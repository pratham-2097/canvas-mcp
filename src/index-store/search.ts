import type { DocumentType, IndexedDocument } from "./types.js";

export interface Chunk {
  doc: IndexedDocument;
  chunkIndex: number;
  text: string;
}

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chunkSize) return text ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

export function chunkDocuments(documents: IndexedDocument[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of documents) {
    const pieces = chunkText(doc.text);
    pieces.forEach((text, i) => chunks.push({ doc, chunkIndex: i, text }));
  }
  return chunks;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * BM25 ranking over a fixed in-memory set of chunks. Designed so a future
 * embeddings-based reranker could slot in behind the same `search()`
 * signature without changing callers — intentionally not built now.
 */
export class BM25Index {
  private readonly chunks: Chunk[];
  private readonly docFreq = new Map<string, number>();
  private readonly termFreqs: Map<string, number>[];
  private readonly docLengths: number[];
  private readonly avgDocLength: number;
  private static readonly K1 = 1.5;
  private static readonly B = 0.75;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.termFreqs = [];
    this.docLengths = [];

    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      this.docLengths.push(tokens.length);

      const tf = new Map<string, number>();
      for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      this.termFreqs.push(tf);

      for (const term of tf.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    const totalLength = this.docLengths.reduce((a, b) => a + b, 0);
    this.avgDocLength = chunks.length > 0 ? totalLength / chunks.length : 0;
  }

  private idf(term: string): number {
    const n = this.chunks.length;
    const df = this.docFreq.get(term) ?? 0;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  score(queryTokens: string[], chunkIndex: number): number {
    const tf = this.termFreqs[chunkIndex];
    const docLength = this.docLengths[chunkIndex];
    if (!tf || docLength === undefined) return 0;
    let score = 0;
    for (const term of queryTokens) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const idf = this.idf(term);
      const numerator = freq * (BM25Index.K1 + 1);
      const denominator = freq + BM25Index.K1 * (1 - BM25Index.B + BM25Index.B * (docLength / (this.avgDocLength || 1)));
      score += idf * (numerator / denominator);
    }
    return score;
  }

  search(query: string, options?: { types?: DocumentType[]; limit?: number }): Array<Chunk & { score: number }> {
    const queryTokens = tokenize(query);
    const limit = options?.limit ?? 20;

    const results = this.chunks
      .map((chunk, i) => ({ ...chunk, score: this.score(queryTokens, i) }))
      .filter((r) => r.score > 0)
      .filter((r) => !options?.types || options.types.includes(r.doc.type));

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
