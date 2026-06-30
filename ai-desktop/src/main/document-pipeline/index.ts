/** DocumentPipeline — main orchestrator */

import { DocumentStore } from './document-store';
import { DocumentParser } from './document-parser';
import { DocumentIndexer } from './document-indexer';
import { DocumentQA } from './document-qa';
import { LLMWikiBuilder } from './llm-wiki';
import { VectorStore } from './vector-store';
import type {
  DocumentMeta, SearchResult, QAAnswer, WikiCard,
  Chunk, CProblemParsed
} from './types';
import { log, logError } from '../utils/logger';
import path from 'node:path';
import os from 'node:os';

export class DocumentPipeline {
  readonly store: DocumentStore;
  readonly parser: DocumentParser;
  readonly indexer: DocumentIndexer;
  readonly qa: DocumentQA;
  readonly wiki: LLMWikiBuilder;
  readonly vectors: VectorStore;

  private dataDir: string;
  private apiKey: string;

  constructor(opts?: { dataDir?: string; apiKey?: string; embeddingBaseUrl?: string }) {
    this.dataDir = opts?.dataDir || path.join(os.homedir(), '.ai-desktop', 'documents');
    this.apiKey = opts?.apiKey || process.env.DEEPSEEK_API_KEY || '';

    this.store = new DocumentStore(this.dataDir);
    this.parser = new DocumentParser(this.store);
    this.vectors = new VectorStore(this.dataDir, {
      apiKey: this.apiKey,
      baseUrl: opts?.embeddingBaseUrl || 'https://api.deepseek.com',
    });
    this.indexer = new DocumentIndexer(this.vectors);
    this.qa = new DocumentQA(this.vectors, {
      apiKey: this.apiKey,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    });
    this.wiki = new LLMWikiBuilder({
      apiKey: this.apiKey,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    });
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    this.vectors.setApiKey(key);
    this.qa.setApiKey(key);
    this.wiki.setApiKey(key);
  }

  // === Document lifecycle ===

  async uploadDocument(filePath: string): Promise<DocumentMeta> {
    const doc = this.store.add(filePath);
    log(`[DocumentPipeline] Uploaded: ${doc.fileName} (${doc.id})`);
    return doc;
  }

  async parseDocument(docId: string): Promise<DocumentMeta> {
    const doc = this.store.get(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);

    this.store.updateStatus(docId, 'parsing');
    try {
      await this.parser.parse(doc);
      this.store.updateStatus(docId, 'completed');
      const updated = this.store.get(docId)!;
      log(`[DocumentPipeline] Parsed: ${updated.fileName}`);
      return updated;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateStatus(docId, 'failed', message);
      logError(`[DocumentPipeline] Parse failed: ${doc.fileName} — ${message}`);
      throw err;
    }
  }

  async indexDocument(docId: string): Promise<Chunk[]> {
    const doc = this.store.get(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);
    if (doc.parseStatus !== 'completed') {
      throw new Error(`Document not parsed yet: ${doc.fileName}`);
    }
    const chunks = await this.indexer.indexDocument(doc);
    log(`[DocumentPipeline] Indexed: ${doc.fileName} — ${chunks.length} chunks`);
    return chunks;
  }

  async processDocument(filePath: string): Promise<DocumentMeta> {
    const doc = await this.uploadDocument(filePath);
    const parsed = await this.parseDocument(doc.id);
    await this.indexDocument(doc.id);
    return parsed;
  }

  // === Query ===

  async search(query: string, topK: number = 10, docIds?: string[]): Promise<SearchResult[]> {
    return this.vectors.searchHybrid(query, { topK, documentIds: docIds });
  }

  async askQuestion(question: string, mode: 'precise' | 'conversational' = 'precise'): Promise<QAAnswer> {
    return this.qa.askQuestion(question, mode);
  }

  async askTableQuestion(question: string, tableId?: string): Promise<QAAnswer> {
    return this.qa.askTableQuestion(question, tableId);
  }

  // === LLM Wiki ===

  async buildWiki(docId: string): Promise<WikiCard | null> {
    const doc = this.store.get(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);
    return this.wiki.buildWikiCard(doc);
  }

  async findCrossReferences(docIds: string[]): Promise<Map<string, import('./types').CrossDocRef[]>> {
    const docs = docIds.map(id => this.store.get(id)).filter((d): d is DocumentMeta => d !== undefined);
    return this.wiki.findCrossReferences(docs);
  }

  // === C Problem specific ===

  async parseCProblem(pdfPath: string): Promise<CProblemParsed> {
    // Specialist: parse a math modeling C problem PDF
    const doc = await this.processDocument(pdfPath);
    const fullText = doc.sections?.map(s => s.content).join('\n\n') || '';

    // Call LLM to extract structured problem info
    // NOTE: DeepSeek does not support response_format: json_object; use prompt-only JSON mode
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          {
            role: 'system',
            content: `你是一个数学建模竞赛专家。请从提供的题目PDF内容中提取结构化信息。
你必须只返回一个严格的JSON对象，不要包含任何markdown代码块标记或其他文本。
JSON对象必须包含以下字段：
- title: 题目标题（字符串）
- background: 题目背景描述（字符串）
- problems: [{index: 问题序号（数字）, description: 问题描述（字符串）, target: 建模目标（字符串）, dataMapping: [相关数据字段（字符串数组）], solutionHint: 解题提示或空字符串}]
- attachments: [{fileName: 附件文件名（字符串）, fileType: "csv"|"xlsx"|"txt"|"other", description: 附件说明（字符串）}]
- dataFields: [{name: 字段名（字符串）, type: "numeric"|"categorical"|"datetime"|"text", unit: 单位或空字符串, missingRate: 0到1之间的数字, description: 字段说明（字符串）}]
- constraints: [约束条件字符串列表]
- evaluationMetrics: [评价指标字符串列表]
- submissionFormat: 提交格式要求（字符串）
- paperRequirements: 论文写作要求（字符串）

直接返回JSON，不要用\`\`\`json包裹。`,
          },
          {
            role: 'user',
            content: `请解析以下数学建模题目：\n\n${fullText.substring(0, 15000)}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    const data = await response.json() as { choices: [{ message: { content: string } }] };
    let rawContent = data.choices[0].message.content.trim();

    // Robust JSON extraction: strip markdown fences if present
    if (rawContent.startsWith('```')) {
      rawContent = rawContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(rawContent) as CProblemParsed;

    // Compute additional stats for data fields from attachments
    for (const field of parsed.dataFields) {
      if (field.missingRate === undefined) field.missingRate = 0;
    }

    log(`[DocumentPipeline] C Problem parsed: ${parsed.title}`);
    return parsed;
  }

  // === Utilities ===

  getDocuments(): DocumentMeta[] {
    return this.store.list();
  }

  getDocument(id: string): DocumentMeta | undefined {
    return this.store.get(id);
  }

  removeDocument(id: string): void {
    this.vectors.removeByDocument(id);
    this.wiki.invalidateCache(id);
    this.store.remove(id);
  }

  // === Eval helpers ===

  async runParseEval(testFiles: { path: string; type: string }[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;
    for (const file of testFiles) {
      try {
        await this.processDocument(file.path);
        success++;
      } catch {
        failed++;
      }
    }
    return { success, failed };
  }
}

let pipeline: DocumentPipeline | null = null;

export function getDocumentPipeline(): DocumentPipeline {
  if (!pipeline) {
    pipeline = new DocumentPipeline();
  }
  return pipeline;
}

export function initDocumentPipeline(opts?: { dataDir?: string; apiKey?: string }): DocumentPipeline {
  pipeline = new DocumentPipeline(opts);
  return pipeline;
}
