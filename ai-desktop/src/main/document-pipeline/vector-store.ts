/**
 * Vector Store — lightweight in-memory + JSON file backing.
 *
 * - Cosine-similarity search when embeddings are enabled.
 * - BM25-like keyword fallback when no embedding API is configured.
 * - Hybrid mode combines both score streams.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { log, logError, logWarn } from '../utils/logger';
import type { Chunk, SearchResult } from './types';

// ── Embedding API configuration ──

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Max number of chunks per batch request (API-dependent). */
  batchSize: number;
}

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'text-embedding-3-small',
  batchSize: 32,
};

// ── Cosine similarity ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ── BM25-like keyword scoring ──

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()\[\]{}"'\u2018-\u201D\u3000-\u303F\uff00-\uffef]+/)
    .filter((t) => t.length > 0);
}

function computeBM25Score(query: string, docText: string, docFreq: Map<string, number>, totalDocs: number, avgDocLen: number): number {
  const k1 = 1.5;
  const b = 0.75;
  const queryTerms = tokenize(query);
  const docTerms = tokenize(docText);
  const docLen = docTerms.length;

  let score = 0;
  for (const term of queryTerms) {
    const df = docFreq.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const tf = docTerms.filter((t) => t === term).length;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLen / Math.max(avgDocLen, 1)));
    score += idf * (numerator / denominator);
  }
  return score;
}

// ── Embedding API caller ──

async function fetchEmbeddings(
  texts: string[],
  config: EmbeddingConfig,
): Promise<number[][]> {
  const url = `${config.baseUrl}/v1/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  // Sort by index to preserve input order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map((item) => item.embedding);
}

// ── VectorStore class ──

export class VectorStore {
  private chunks: Map<string, Chunk> = new Map();
  private persistPath: string;
  private embeddingConfig: EmbeddingConfig;
  private embeddingsEnabled: boolean;
  /** Cached BM25 index: term → document frequency */
  private termDocFreq: Map<string, number> = new Map();
  private totalDocsForBM25 = 0;
  private bm25Dirty = false;

  constructor(dataDir: string, embeddingConfig?: Partial<EmbeddingConfig>) {
    this.persistPath = path.join(dataDir, 'vector-store.json');
    this.embeddingConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...embeddingConfig };
    this.embeddingsEnabled = !!this.embeddingConfig.apiKey;
    this.load();
  }

  // ── Persistence ──

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const entries: Array<[string, Chunk]> = JSON.parse(raw);
        this.chunks = new Map(entries);
        log(`[VectorStore] Loaded ${this.chunks.size} chunks from disk`);
        this.rebuildBM25Index();
      }
    } catch (err) {
      logError('[VectorStore] Failed to load from disk, starting fresh', err);
      this.chunks = new Map();
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const entries = Array.from(this.chunks.entries());
      fs.writeFileSync(this.persistPath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      logError('[VectorStore] Failed to persist to disk', err);
    }
  }

  // ── Embedding config ──

  /** Set or update the API key. Enables embedding-based search. */
  setApiKey(apiKey: string): void {
    this.embeddingConfig.apiKey = apiKey;
    this.embeddingsEnabled = !!apiKey;
    log(`[VectorStore] Embeddings ${this.embeddingsEnabled ? 'enabled' : 'disabled'}`);
  }

  /** Override model or base URL. */
  setEmbeddingConfig(config: Partial<EmbeddingConfig>): void {
    Object.assign(this.embeddingConfig, config);
    this.embeddingsEnabled = !!this.embeddingConfig.apiKey;
  }

  get embeddingsAvailable(): boolean {
    return this.embeddingsEnabled;
  }

  // ── Chunk CRUD ──

  addChunk(chunk: Chunk): void {
    if (!chunk.id) chunk.id = randomUUID();
    this.chunks.set(chunk.id, chunk);
    this.bm25Dirty = true;
    this.persist();
  }

  async addChunks(chunks: Chunk[]): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk.id) chunk.id = randomUUID();
      this.chunks.set(chunk.id, chunk);
    }
    this.bm25Dirty = true;
    this.persist();
    log(`[VectorStore] Added ${chunks.length} chunks`);
  }

  /** Generate an embedding vector for a single text. */
  async embed(text: string): Promise<number[]> {
    if (!this.embeddingsEnabled) {
      throw new Error('Embedding API not configured');
    }
    const embeddings = await fetchEmbeddings([text], this.embeddingConfig);
    return embeddings[0];
  }

  removeChunk(id: string): boolean {
    const removed = this.chunks.delete(id);
    if (removed) {
      this.bm25Dirty = true;
      this.persist();
    }
    return removed;
  }

  getChunk(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }

  listChunks(): Chunk[] {
    return Array.from(this.chunks.values());
  }

  /** Remove all chunks for a given document (sync, returns count). */
  removeByDocument(documentId: string): number {
    let count = 0;
    for (const [id, chunk] of Array.from(this.chunks)) {
      if (chunk.documentId === documentId) {
        this.chunks.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.bm25Dirty = true;
      this.persist();
    }
    return count;
  }

  /** Alias for removeByDocument — matches the interface expected by DocumentIndexer. */
  async deleteByDocumentId(documentId: string): Promise<void> {
    let count = 0;
    for (const [id, chunk] of Array.from(this.chunks)) {
      if (chunk.documentId === documentId) {
        this.chunks.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.bm25Dirty = true;
      this.persist();
    }
  }

  get count(): number {
    return this.chunks.size;
  }

  // ── Embedding generation ──

  /**
   * Generate embeddings for all chunks that don't already have one.
   * Chunks are batched and sent to the configured endpoint.
   */
  async generateEmbeddings(progressCb?: (done: number, total: number) => void): Promise<void> {
    if (!this.embeddingsEnabled) {
      logWarn('[VectorStore] Embedding API not configured, skipping embedding generation');
      return;
    }

    const unembedded: Chunk[] = [];
    for (const chunk of Array.from(this.chunks.values())) {
      if (!chunk.embedding || chunk.embedding.length === 0) {
        unembedded.push(chunk);
      }
    }

    if (unembedded.length === 0) {
      log('[VectorStore] All chunks already have embeddings');
      return;
    }

    const batchSize = this.embeddingConfig.batchSize;
    let done = 0;

    for (let i = 0; i < unembedded.length; i += batchSize) {
      const batch = unembedded.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content.slice(0, 8000)); // Truncate to 8K chars for API

      try {
        const embeddings = await fetchEmbeddings(
          texts,
          this.embeddingConfig,
        );
        for (let j = 0; j < embeddings.length; j++) {
          batch[j].embedding = embeddings[j];
        }
        done += batch.length;
        progressCb?.(done, unembedded.length);
        log(`[VectorStore] Embedded ${done}/${unembedded.length} chunks`);
      } catch (err) {
        logError(
          `[VectorStore] Embedding batch failed (chunks ${i}-${i + batch.length}): ${err}`,
        );
        // Continue with next batch — don't wipe the whole job
      }
    }

    this.persist();
  }

  // ── BM25 index ──

  private rebuildBM25Index(): void {
    this.termDocFreq = new Map();
    this.totalDocsForBM25 = 0;
    for (const chunk of Array.from(this.chunks.values())) {
      const terms = Array.from(new Set(tokenize(chunk.content)));
      for (const term of terms) {
        this.termDocFreq.set(term, (this.termDocFreq.get(term) ?? 0) + 1);
      }
      this.totalDocsForBM25++;
    }
    this.bm25Dirty = false;
  }

  private ensureBM25Index(): void {
    if (this.bm25Dirty) {
      this.rebuildBM25Index();
    }
  }

  // ── Search ──

  /**
   * Pure embedding-based search. Returns top-k matches by cosine similarity.
   * If embedding is on the query but some chunks lack embeddings, those
   * chunks are skipped.
   */
  async search(
    queryEmbedding: number[],
    topK: number = 10,
  ): Promise<SearchResult[]> {
    const chunkList = Array.from(this.chunks.values());
    const scored: Array<{ chunk: Chunk; score: number }> = [];

    for (const chunk of chunkList) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue;
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score > 0) {
        scored.push({ chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ chunk, score }) => ({
      chunk,
      score,
      evidence: {
        fileName: chunk.metadata.fileName,
        pageNumber: chunk.metadata.pageNumber,
        sectionTitle: chunk.metadata.sectionTitle,
        tableId: chunk.metadata.tableId,
        cellRange: chunk.metadata.cellRange,
        contentType: chunk.chunkType,
      },
    }));
  }

  /**
   * BM25-like keyword search. Used as fallback when no embeddings API is
   * configured, or in hybrid mode to complement vector scores.
   */
  keywordSearch(query: string, topK: number = 10): SearchResult[] {
    this.ensureBM25Index();
    const chunkList = Array.from(this.chunks.values());

    // Compute average doc length
    const totalLen = chunkList.reduce(
      (sum, c) => sum + tokenize(c.content).length,
      0,
    );
    const avgDocLen = chunkList.length > 0 ? totalLen / chunkList.length : 1;

    const scored = chunkList.map((chunk) => {
      const score = computeBM25Score(
        query,
        chunk.content,
        this.termDocFreq,
        this.totalDocsForBM25,
        avgDocLen,
      );
      return { chunk, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0)
      .slice(0, topK)
      .map(({ chunk, score }) => ({
        chunk,
        score,
        evidence: {
          fileName: chunk.metadata.fileName,
          pageNumber: chunk.metadata.pageNumber,
          sectionTitle: chunk.metadata.sectionTitle,
          tableId: chunk.metadata.tableId,
          cellRange: chunk.metadata.cellRange,
          contentType: chunk.chunkType,
        },
      }));
  }

  /**
   * Hybrid search: combines embedding cosine similarity with BM25 keyword
   * scoring using reciprocal rank fusion (RRF).
   *
   * When embeddings are not available, falls back to pure keyword search.
   */
  async searchHybrid(
    query: string,
    options?: { topK?: number; documentIds?: string[] },
  ): Promise<SearchResult[]> {
    const topK = options?.topK ?? 10;
    const documentIds = options?.documentIds;

    // Helper to filter by document
    const filterByDoc = (results: SearchResult[]) => {
      if (!documentIds || documentIds.length === 0) return results;
      return results.filter((r) => documentIds.includes(r.chunk.documentId));
    };

    if (!this.embeddingsEnabled) {
      log('[VectorStore] Embeddings disabled, using keyword-only search');
      return filterByDoc(this.keywordSearch(query, topK));
    }

    // Get embedding for the query
    let queryEmbedding: number[];
    try {
      const embeddings = await fetchEmbeddings([query], this.embeddingConfig);
      queryEmbedding = embeddings[0];
    } catch (err) {
      logError(`[VectorStore] Failed to get query embedding: ${err}`);
      return filterByDoc(this.keywordSearch(query, topK));
    }

    // Run both searches in parallel
    const candidateLimit = topK * 3;
    const [vectorResults, keywordResults] = await Promise.all([
      this.search(queryEmbedding, candidateLimit),
      Promise.resolve(this.keywordSearch(query, candidateLimit)),
    ]);

    // Reciprocal rank fusion
    const rrfScores = new Map<
      string,
      { chunk: Chunk; rrfScore: number; vectorScore: number; keywordScore: number }
    >();
    const k = 60; // RRF constant

    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[i].chunk.id;
      const entry = rrfScores.get(id) ?? {
        chunk: vectorResults[i].chunk,
        rrfScore: 0,
        vectorScore: 0,
        keywordScore: 0,
      };
      entry.rrfScore += 1 / (k + i + 1);
      entry.vectorScore = vectorResults[i].score;
      rrfScores.set(id, entry);
    }

    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[i].chunk.id;
      const entry = rrfScores.get(id);
      if (entry) {
        entry.rrfScore += 1 / (k + i + 1);
        entry.keywordScore = keywordResults[i].score;
      } else {
        rrfScores.set(id, {
          chunk: keywordResults[i].chunk,
          rrfScore: 1 / (k + i + 1),
          vectorScore: 0,
          keywordScore: keywordResults[i].score,
        });
      }
    }

    // Sort by RRF score, return top-K
    const fused = Array.from(rrfScores.values());
    fused.sort((a, b) => b.rrfScore - a.rrfScore);

    const results = fused.slice(0, topK).map((entry) => ({
      chunk: entry.chunk,
      score: entry.rrfScore,
      evidence: {
        fileName: entry.chunk.metadata.fileName,
        pageNumber: entry.chunk.metadata.pageNumber,
        sectionTitle: entry.chunk.metadata.sectionTitle,
        tableId: entry.chunk.metadata.tableId,
        cellRange: entry.chunk.metadata.cellRange,
        contentType: entry.chunk.chunkType,
      },
    }));

    return filterByDoc(results);
  }

  /** Clear all chunks and reset the BM25 index. */
  clear(): void {
    this.chunks.clear();
    this.termDocFreq.clear();
    this.totalDocsForBM25 = 0;
    this.persist();
    log('[VectorStore] Cleared all chunks');
  }
}
