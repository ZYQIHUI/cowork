/**
 * Document Store — in-memory Map + JSON file persistence for document metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { log, logError } from '../utils/logger';
import type { DocumentMeta } from './types';

const FILE_EXTENSION_MAP: Record<string, DocumentMeta['fileType']> = {
  '.pdf': 'pdf',
  '.docx': 'word',
  '.doc': 'word',
  '.pptx': 'ppt',
  '.ppt': 'ppt',
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.csv': 'csv',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'txt',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.tiff': 'image',
  '.tif': 'image',
  '.webp': 'image',
};

function detectFileType(filePath: string): DocumentMeta['fileType'] {
  const ext = path.extname(filePath).toLowerCase();
  return FILE_EXTENSION_MAP[ext] ?? 'txt';
}

export class DocumentStore {
  private documents: Map<string, DocumentMeta> = new Map();
  private persistPath: string;
  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, 'document-store.json');
    this.load();
  }

  // ── Persistence ──

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const entries: Array<[string, DocumentMeta]> = JSON.parse(raw);
        this.documents = new Map(entries);
        log(`[DocumentStore] Loaded ${this.documents.size} documents from disk`);
      }
    } catch (err) {
      logError('[DocumentStore] Failed to load from disk, starting fresh', err);
      this.documents = new Map();
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const entries = Array.from(this.documents.entries());
      fs.writeFileSync(this.persistPath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      logError('[DocumentStore] Failed to persist to disk', err);
    }
  }

  // ── CRUD ──

  /**
   * Add a document by file path. Detects file type from extension,
   * reads file size from disk, and assigns a unique ID.
   */
  add(filePath: string): DocumentMeta {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const id = randomUUID();
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const fileType = detectFileType(filePath);

    const meta: DocumentMeta = {
      id,
      fileName,
      filePath,
      fileType,
      fileSize: stat.size,
      uploadTime: Date.now(),
      parseStatus: 'pending',
    };

    this.documents.set(id, meta);
    this.persist();
    log(`[DocumentStore] Added document: ${fileName} (${id})`);
    return meta;
  }

  /** Remove a document by ID. */
  remove(id: string): boolean {
    const deleted = this.documents.delete(id);
    if (deleted) {
      this.persist();
      log(`[DocumentStore] Removed document: ${id}`);
    }
    return deleted;
  }

  /** Get a single document by ID. */
  get(id: string): DocumentMeta | undefined {
    return this.documents.get(id);
  }

  /** List all documents. */
  list(): DocumentMeta[] {
    return Array.from(this.documents.values());
  }

  /** Update parse status (and optionally set an error). */
  updateStatus(
    id: string,
    status: DocumentMeta['parseStatus'],
    error?: string
  ): void {
    const doc = this.documents.get(id);
    if (!doc) {
      logError(`[DocumentStore] updateStatus: document not found: ${id}`);
      return;
    }
    doc.parseStatus = status;
    if (error) doc.parseError = error;
    if (status === 'parsing') {
      doc.parseLog = doc.parseLog ?? [];
    }
    this.persist();
  }

  /** Append a log entry to a document's parse log. */
  appendLog(id: string, entry: string): void {
    const doc = this.documents.get(id);
    if (!doc) return;
    doc.parseLog = doc.parseLog ?? [];
    doc.parseLog.push(`[${new Date().toISOString()}] ${entry}`);
  }

  /** Update parsed content fields (sections, tables, images, pageCount). */
  updateParsedContent(
    id: string,
    updates: Partial<
      Pick<DocumentMeta, 'sections' | 'tables' | 'images' | 'pageCount'>
    >,
  ): void {
    const doc = this.documents.get(id);
    if (!doc) return;
    if (updates.sections !== undefined) doc.sections = updates.sections;
    if (updates.tables !== undefined) doc.tables = updates.tables;
    if (updates.images !== undefined) doc.images = updates.images;
    if (updates.pageCount !== undefined) doc.pageCount = updates.pageCount;
    this.persist();
  }

  /** Return the number of stored documents. */
  get count(): number {
    return this.documents.size;
  }
}
