/**
 * Document Indexer — chunks parsed DocumentMeta and indexes chunks via VectorStore.
 */

import type {
  DocumentMeta,
  DocumentSection,
  ParsedTable,
  ParsedImage,
  Chunk,
} from './types';
import { log, logWarn, logError } from '../utils/logger';
import { randomUUID } from 'node:crypto';

// ── VectorStore interface (minimal contract expected by the indexer) ──

export interface VectorStore {
  /** Store a batch of chunks (with optional embeddings attached). */
  addChunks(chunks: Chunk[]): Promise<void>;
  /** Remove every chunk belonging to a document. */
  deleteByDocumentId(documentId: string): Promise<void>;
  /** Generate an embedding vector for the given text. */
  embed?(text: string): Promise<number[]>;
}

// ── Options ──

export interface IndexerOptions {
  /** Max characters per text chunk (default 1000). */
  maxChunkChars: number;
  /** Overlap in characters between consecutive chunks (default 100). */
  overlapChars: number;
  /** Whether to generate embeddings for each chunk (default true). */
  embedChunks: boolean;
  /** Batch size for parallel embedding calls (default 8). */
  embeddingBatchSize: number;
}

const DEFAULT_OPTIONS: IndexerOptions = {
  maxChunkChars: 1000,
  overlapChars: 100,
  embedChunks: true,
  embeddingBatchSize: 8,
};

// ── Token counting utility (fast approximate) ──

function estimateTokenCount(text: string): number {
  // Conservative approximation: ~0.75 tokens per character for English/Chinese mixed
  // Closer to 1 token per character for CJK, ~0.25 for English words (~4 chars/word)
  const totalChars = text.length;
  // Count CJK characters roughly
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = totalChars - cjkCount;
  // CJK ~1.5 tokens/char, non-CJK ~0.3 tokens/char (including spaces)
  return Math.max(1, Math.ceil(cjkCount * 1.5 + nonCjk * 0.3));
}

// ── Helpers ──

function makeChunkId(): string {
  return `chunk-${randomUUID()}`;
}

// ── DocumentIndexer ──

export class DocumentIndexer {
  private vectorStore: VectorStore;
  private options: IndexerOptions;
  private indexedDocuments: Map<string, number>; // documentId → chunkCount

  constructor(vectorStore: VectorStore, options?: Partial<IndexerOptions>) {
    this.vectorStore = vectorStore;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.indexedDocuments = new Map();
  }

  // ── Public API ──

  /**
   * Index a parsed document: chunk it, optionally embed, store in VectorStore.
   * Returns all chunks that were created.
   */
  async indexDocument(doc: DocumentMeta): Promise<Chunk[]> {
    const startTime = Date.now();
    log(`[DocumentIndexer] Indexing document "${doc.fileName}" (${doc.id})`);

    try {
      const chunks: Chunk[] = [];

      // 1. Text chunks from sections
      if (doc.sections && doc.sections.length > 0) {
        chunks.push(...this.chunkSections(doc.sections, doc));
      }

      // 2. Table chunks — one per parsed table
      if (doc.tables && doc.tables.length > 0) {
        chunks.push(...this.chunkTables(doc.tables, doc));
      }

      // 3. Image chunks — one per parsed image with OCR text
      if (doc.images && doc.images.length > 0) {
        chunks.push(...this.chunkImages(doc.images, doc));
      }

      if (chunks.length === 0) {
        logWarn(`[DocumentIndexer] No content to index for "${doc.fileName}"`);
        this.indexedDocuments.set(doc.id, 0);
        return [];
      }

      // 4. Generate embeddings in batches
      if (this.options.embedChunks && this.vectorStore.embed) {
        await this.embedChunksInBatches(chunks);
      }

      // 5. Store chunks via VectorStore
      await this.vectorStore.addChunks(chunks);

      this.indexedDocuments.set(doc.id, chunks.length);

      const elapsed = Date.now() - startTime;
      log(
        `[DocumentIndexer] Indexed ${chunks.length} chunks for "${doc.fileName}" in ${elapsed}ms`
      );
      return chunks;
    } catch (err) {
      logError(`[DocumentIndexer] Failed to index "${doc.fileName}":`, err);
      throw err;
    }
  }

  /**
   * Re-index a document: remove all its existing chunks, then re-chunk and store.
   */
  async reindexDocument(doc: DocumentMeta): Promise<Chunk[]> {
    log(`[DocumentIndexer] Re-indexing document "${doc.fileName}" (${doc.id})`);
    await this.clearDocument(doc.id);
    return this.indexDocument(doc);
  }

  /**
   * Clear all chunks belonging to a document from the index.
   */
  async clearDocument(documentId: string): Promise<void> {
    log(`[DocumentIndexer] Clearing chunks for document ${documentId}`);
    try {
      await this.vectorStore.deleteByDocumentId(documentId);
      this.indexedDocuments.delete(documentId);
    } catch (err) {
      logError(`[DocumentIndexer] Failed to clear chunks for ${documentId}:`, err);
      throw err;
    }
  }

  /**
   * Return the list of currently-indexed document IDs.
   */
  getIndexedDocuments(): string[] {
    return Array.from(this.indexedDocuments.keys());
  }

  /**
   * Return the number of chunks stored for a specific document.
   */
  getChunkCount(documentId: string): number {
    return this.indexedDocuments.get(documentId) ?? 0;
  }

  // ── Private: Chunking ──

  /**
   * Split sections into text chunks.
   *
   * Strategy:
   *  1. Walk through each section.
   *  2. Split the section content into paragraphs (double newline).
   *  3. Accumulate paragraphs until we approach maxChunkChars, then emit a chunk.
   *  4. Overlap: keep the last few paragraphs as the start of the next chunk.
   */
  private chunkSections(sections: DocumentSection[], doc: DocumentMeta): Chunk[] {
    const chunks: Chunk[] = [];
    const { maxChunkChars, overlapChars } = this.options;

    for (const section of sections) {
      if (!section.content || section.content.trim().length === 0) continue;

      const paragraphs = this.splitParagraphs(section.content);
      if (paragraphs.length === 0) continue;

      let chunkIndex = 0;
      let buffer = '';
      let bufferChars = 0;
      let overlapBuffer = '';

      for (let i = 0; i < paragraphs.length; i++) {
        const para = paragraphs[i];
        const paraChars = para.length;

        // If adding this paragraph exceeds the limit, emit current buffer
        if (bufferChars + paraChars > maxChunkChars && bufferChars > 0) {
          const chunkContent = buffer.trim();
          if (chunkContent.length > 0) {
            const chunk: Chunk = {
              id: makeChunkId(),
              documentId: doc.id,
              chunkType: 'text',
              content: chunkContent,
              metadata: {
                fileName: doc.fileName,
                pageNumber: section.pageStart,
                sectionTitle: section.title,
                chunkIndex,
                tokenCount: estimateTokenCount(chunkContent),
              },
            };
            chunks.push(chunk);
            chunkIndex++;
          }

          // Create overlap: keep recent text up to overlapChars
          overlapBuffer = this.extractOverlap(buffer, overlapChars);
          buffer = overlapBuffer ? overlapBuffer + '\n\n' + para : para;
          bufferChars = buffer.length;
        } else {
          if (buffer.length > 0) buffer += '\n\n';
          buffer += para;
          bufferChars = buffer.length;
        }
      }

      // Emit remaining buffer
      const remaining = buffer.trim();
      if (remaining.length > 0) {
        const chunk: Chunk = {
          id: makeChunkId(),
          documentId: doc.id,
          chunkType: 'text',
          content: remaining,
          metadata: {
            fileName: doc.fileName,
            pageNumber: section.pageStart,
            sectionTitle: section.title,
            chunkIndex,
            tokenCount: estimateTokenCount(remaining),
          },
        };
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  /**
   * Split content into paragraphs using double-newline boundaries,
   * then optionally split very long paragraphs further by sentence boundaries.
   */
  private splitParagraphs(content: string): string[] {
    const rawParagraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);

    const result: string[] = [];
    for (const para of rawParagraphs) {
      if (para.length <= this.options.maxChunkChars) {
        result.push(para);
      } else {
        // Split long paragraphs by sentence boundaries
        const sentences = para.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [para];
        let current = '';
        for (const sent of sentences) {
          if (current.length + sent.length > this.options.maxChunkChars && current.length > 0) {
            result.push(current.trim());
            current = sent;
          } else {
            current += sent;
          }
        }
        if (current.trim().length > 0) result.push(current.trim());
      }
    }

    return result;
  }

  /**
   * Extract trailing text up to `overlapChars` characters from the buffer,
   * used to seed the next chunk for context continuity.
   */
  private extractOverlap(buffer: string, overlapChars: number): string {
    if (buffer.length <= overlapChars) return buffer;
    // Start from a paragraph boundary within the overlap window
    const tail = buffer.slice(-overlapChars);
    const paraBreak = tail.indexOf('\n\n');
    if (paraBreak > 0) {
      return tail.slice(paraBreak + 2);
    }
    // Fall back to a sentence boundary
    const sentMatch = tail.match(/[。！？.!?]\s*/g);
    if (sentMatch && sentMatch.length > 0) {
      const lastSentIdx = tail.lastIndexOf(sentMatch[sentMatch.length - 1]);
      if (lastSentIdx > 0) {
        return tail.slice(lastSentIdx + 1);
      }
    }
    return tail;
  }

  /**
   * Create one chunk per parsed table, using the markdown representation.
   */
  private chunkTables(tables: ParsedTable[], doc: DocumentMeta): Chunk[] {
    const chunks: Chunk[] = [];

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const content = this.formatTableForChunk(table);
      if (!content.trim()) continue;

      chunks.push({
        id: makeChunkId(),
        documentId: doc.id,
        chunkType: 'table',
        content,
        metadata: {
          fileName: doc.fileName,
          pageNumber: table.page,
          tableId: table.id,
          chunkIndex: i,
          tokenCount: estimateTokenCount(content),
        },
      });
    }

    return chunks;
  }

  /**
   * Format a parsed table into a text representation suitable for embedding and retrieval.
   */
  private formatTableForChunk(table: ParsedTable): string {
    const parts: string[] = [];

    if (table.caption) {
      parts.push(`[Table: ${table.caption}]`);
    } else {
      parts.push(`[Table on page ${table.page}]`);
    }

    // Use the markdown representation as the primary content
    if (table.markdown) {
      parts.push(table.markdown);
    } else {
      // Build a simple text representation from headers and rows
      if (table.headers.length > 0) {
        const headerText = table.headers.map((h) => h.text).join(' | ');
        parts.push(headerText);
        parts.push('-'.repeat(headerText.length));
      }
      for (const row of table.rows) {
        parts.push(row.join(' | '));
      }
    }

    // Append CSV for structured searchability
    if (table.csv) {
      parts.push(`\n[CSV]\n${table.csv}`);
    }

    return parts.join('\n');
  }

  /**
   * Create one chunk per image that has OCR text.
   */
  private chunkImages(images: ParsedImage[], doc: DocumentMeta): Chunk[] {
    const chunks: Chunk[] = [];

    for (let i = 0; i < images.length; i++) {
      const image = images[i];

      // Only index images that have OCR content
      const textContent = image.ocrText?.trim();
      if (!textContent) continue;

      const contentParts: string[] = [];
      if (image.caption) {
        contentParts.push(`[Image: ${image.caption}]`);
      } else {
        contentParts.push(`[Image on page ${image.page}]`);
      }
      contentParts.push(textContent);

      if (image.ocrConfidence !== undefined) {
        contentParts.push(`[OCR confidence: ${(image.ocrConfidence * 100).toFixed(0)}%]`);
      }

      const content = contentParts.join('\n');

      chunks.push({
        id: makeChunkId(),
        documentId: doc.id,
        chunkType: 'image',
        content,
        metadata: {
          fileName: doc.fileName,
          pageNumber: image.page,
          imageId: image.id,
          chunkIndex: i,
          tokenCount: estimateTokenCount(content),
        },
      });
    }

    return chunks;
  }

  // ── Private: Embedding ──

  /**
   * Generate embeddings for all chunks in parallel batches.
   */
  private async embedChunksInBatches(chunks: Chunk[]): Promise<void> {
    const embedFn = this.vectorStore.embed;
    if (!embedFn) return;

    const batchSize = this.options.embeddingBatchSize;
    if (batchSize <= 1) {
      // Sequential
      for (const chunk of chunks) {
        try {
          chunk.embedding = await embedFn(chunk.content);
        } catch (err) {
          logWarn(`[DocumentIndexer] Failed to embed chunk ${chunk.id}:`, err);
        }
      }
      return;
    }

    // Parallel batches
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((chunk) => embedFn(chunk.content))
      );

      results.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          batch[idx].embedding = result.value;
        } else {
          logWarn(
            `[DocumentIndexer] Failed to embed chunk ${batch[idx].id}:`,
            result.reason
          );
        }
      });
    }
  }
}
