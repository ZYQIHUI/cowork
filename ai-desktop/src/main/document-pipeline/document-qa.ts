/**
 * Document QA — question answering engine over indexed document chunks.
 *
 * Uses VectorStore.searchHybrid() to retrieve relevant chunks, then calls
 * the DeepSeek LLM (OpenAI-compatible endpoint) with the retrieved context
 * to produce an answer with evidence.
 */

import type {
  QAAnswer,
  EvidenceItem,
  SearchResult,
} from './types';
import { log, logError } from '../utils/logger';

// ── Search options expected by VectorStore ──

export interface SearchOptions {
  /** Maximum number of results to return (default 10). */
  topK?: number;
  /** Restrict search to specific documents. */
  documentIds?: string[];
}

export interface VectorStoreWithSearch {
  searchHybrid(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

// ── QA mode ──

export type QAMode = 'precise' | 'conversational';

// ── QA constructor options ──

export interface DocumentQAOptions {
  /** DeepSeek API base URL (default https://api.deepseek.com). */
  baseUrl: string;
  /** Model name (default deepseek-v4-pro). */
  model: string;
  /** API key. Falls back to DEEPSEEK_API_KEY env var. */
  apiKey?: string;
  /** Max context chunks to retrieve (default 10). */
  maxChunks: number;
  /** Max tokens for the LLM response (default 2048). */
  maxTokens: number;
  /** Temperature for LLM sampling (default 0.1 for precise, 0.5 for conversational). */
  temperature?: number;
  /** Request timeout in ms (default 60000). */
  timeoutMs: number;
}

const DEFAULT_OPTIONS: DocumentQAOptions = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  maxChunks: 10,
  maxTokens: 2048,
  timeoutMs: 60_000,
};

// ── Simple token estimator ──

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.5 + nonCjk * 0.3));
}

// ── Chunk to evidence mapping ──

function chunkToEvidence(result: SearchResult): EvidenceItem {
  const { chunk, evidence } = result;
  // Determine best excerpt: first ~300 chars of content
  const excerpt =
    chunk.content.length > 300
      ? chunk.content.slice(0, 300) + '…'
      : chunk.content;

  return {
    type: chunk.chunkType,
    fileName: evidence.fileName,
    pageNumber: evidence.pageNumber,
    sectionTitle: evidence.sectionTitle,
    tableId: evidence.tableId,
    cellRange: evidence.cellRange,
    imageId: chunk.metadata.imageId,
    excerpt,
  };
}

// ── DocumentQA ──

export class DocumentQA {
  private vectorStore: VectorStoreWithSearch;
  private options: DocumentQAOptions;
  private apiKey: string;

  constructor(
    vectorStore: VectorStoreWithSearch,
    options?: Partial<DocumentQAOptions>
  ) {
    this.vectorStore = vectorStore;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.apiKey =
      this.options.apiKey ||
      process.env.DEEPSEEK_API_KEY ||
      '';
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    this.options.apiKey = key;
  }

  // ── Public: ask a question ──

  /**
   * Ask a general question about the indexed documents.
   *
   * @param question   The natural-language question.
   * @param mode       "precise" for factual answers with mandatory evidence,
   *                   "conversational" for broader interpretive answers.
   * @param documentIds Optional list of document IDs to restrict the search.
   */
  async askQuestion(
    question: string,
    mode: QAMode = 'precise',
    documentIds?: string[]
  ): Promise<QAAnswer> {
    const startTime = Date.now();
    log(`[DocumentQA] Question (${mode}): "${question.slice(0, 120)}"`);

    try {
      // 1. Retrieve relevant chunks
      const searchOpts: SearchOptions = {
        topK: this.options.maxChunks,
      };

      const allResults: SearchResult[] = [];

      if (documentIds && documentIds.length > 0) {
        // Search restricted to specific documents
        const results = await this.vectorStore.searchHybrid(question, {
          ...searchOpts,
          documentIds,
        });
        allResults.push(...results);
      } else {
        const results = await this.vectorStore.searchHybrid(question, searchOpts);
        allResults.push(...results);
      }

      if (allResults.length === 0) {
        return {
          question,
          answer: 'No relevant content found in the indexed documents to answer this question.',
          evidence: [],
          confidence: 0,
          modelUsed: this.options.model,
          tokensUsed: { input: 0, output: 0 },
        };
      }

      // 2. Build context from retrieved chunks
      const evidence = allResults.map(chunkToEvidence);
      const context = this.buildContext(allResults, mode);

      // 3. Build system + user prompts
      const systemPrompt = this.buildSystemPrompt(mode);
      const userPrompt = this.buildUserPrompt(question, context);

      // 4. Determine temperature for this mode
      const temperature =
        this.options.temperature ??
        (mode === 'precise' ? 0.1 : 0.5);

      // 5. Call LLM
      const { answerText, inputTokens, outputTokens } = await this.callLLM(
        systemPrompt,
        userPrompt,
        temperature
      );

      // 6. Compute confidence
      const confidence = this.computeConfidence(allResults, evidence, answerText, mode);

      const elapsed = Date.now() - startTime;
      log(
        `[DocumentQA] Answered in ${elapsed}ms, confidence=${confidence.toFixed(2)}, ` +
        `tokens: in=${inputTokens} out=${outputTokens}`
      );

      return {
        question,
        answer: answerText,
        evidence,
        confidence,
        modelUsed: this.options.model,
        tokensUsed: { input: inputTokens, output: outputTokens },
      };
    } catch (err) {
      logError('[DocumentQA] Failed to answer question:', err);
      throw err;
    }
  }

  // ── Public: table-specific question ──

  /**
   * Ask a question specifically about table data.
   * Supports aggregation keywords: sum, average/avg, max, min,
   * filter/where, compare/comparison, count.
   *
   * @param question  The natural-language question about tables.
   * @param tableId   Optional specific table ID to narrow the search.
   */
  async askTableQuestion(
    question: string,
    tableId?: string
  ): Promise<QAAnswer> {
    const startTime = Date.now();
    const lowered = question.toLowerCase();

    // Detect the operation requested
    const isAggregate =
      /\b(sum|average|avg|max|min|count|total|mean)\b/i.test(lowered);
    const isFilter = /\b(filter|where|find|show|list|get|select)\b/i.test(lowered);
    const isCompare = /\b(compare|comparison|versus|vs\.?|difference|diff)\b/i.test(lowered);

    let operationHint = '';
    if (isAggregate) operationHint = 'aggregation';
    if (isFilter) operationHint = operationHint ? `${operationHint}+filter` : 'filter';
    if (isCompare) operationHint = operationHint ? `${operationHint}+comparison` : 'comparison';

    log(
      `[DocumentQA] Table question${operationHint ? ` (${operationHint})` : ''}: ` +
      `"${question.slice(0, 120)}"`
    );

    try {
      // 1. Retrieve relevant table chunks
      const searchOpts: SearchOptions = {
        topK: Math.max(this.options.maxChunks, 15), // tables may need more chunks
      };

      const results = await this.vectorStore.searchHybrid(question, searchOpts);

      // Filter to specific table if requested
      const relevant =
        tableId
          ? results.filter((r) => r.chunk.metadata.tableId === tableId)
          : results;

      if (relevant.length === 0) {
        return {
          question,
          answer: 'No relevant table data found to answer this question.',
          evidence: [],
          confidence: 0,
          modelUsed: this.options.model,
          tokensUsed: { input: 0, output: 0 },
        };
      }

      // 2. Build evidence from table chunks
      const evidence = relevant.map(chunkToEvidence);
      const context = this.buildTableContext(relevant);

      // 3. Build prompts for table analysis
      const systemPrompt = this.buildTableSystemPrompt(operationHint);
      const userPrompt = this.buildUserPrompt(question, context);

      // 4. Call LLM
      const temperature = this.options.temperature ?? 0.1;
      const { answerText, inputTokens, outputTokens } = await this.callLLM(
        systemPrompt,
        userPrompt,
        temperature
      );

      const confidence = this.computeConfidence(relevant, evidence, answerText, 'precise');

      const elapsed = Date.now() - startTime;
      log(
        `[DocumentQA] Table question answered in ${elapsed}ms, ` +
        `tokens: in=${inputTokens} out=${outputTokens}`
      );

      return {
        question,
        answer: answerText,
        evidence,
        confidence,
        modelUsed: this.options.model,
        tokensUsed: { input: inputTokens, output: outputTokens },
      };
    } catch (err) {
      logError('[DocumentQA] Failed to answer table question:', err);
      throw err;
    }
  }

  // ── Private: prompt builders ──

  private buildSystemPrompt(mode: QAMode): string {
    if (mode === 'precise') {
      return [
        'You are a precise document question-answering assistant.',
        'Your task is to answer questions based SOLELY on the provided document context.',
        '',
        'Rules:',
        '1. Only use information explicitly present in the context below.',
        '2. If the context does not contain enough information, say so clearly.',
        '3. For every factual claim, cite the source (e.g., "[Section: X, Page: Y]").',
        '4. Be concise but complete.',
        '5. If tables contain the relevant data, reference them specifically.',
        '6. Do not make up information or speculate beyond the provided context.',
      ].join('\n');
    }

    // Conversational mode
    return [
      'You are a helpful document analysis assistant.',
      'Your task is to provide informative answers drawing from the provided document context.',
      '',
      'Rules:',
      '1. Base your answer primarily on the provided context.',
      '2. You may provide broader context or explanations where helpful, but indicate when you are doing so.',
      '3. Reference the source material naturally (e.g., "As described in Section X...").',
      '4. Be thorough and explanatory.',
      '5. If the context lacks information, acknowledge the gap and offer what you can.',
    ].join('\n');
  }

  private buildTableSystemPrompt(operationHint: string): string {
    const base = [
      'You are a precise table-data analysis assistant.',
      'Your task is to analyze the provided table data and answer questions accurately.',
      '',
      'Rules:',
      '1. Base your answer ONLY on the provided table data.',
      '2. For calculations (sum, average, max, min), show your work briefly.',
      '3. For filters/comparisons, list the relevant rows explicitly.',
      '4. Reference the specific table and column names in your answer.',
      '5. If the data is insufficient, state what is missing.',
      '6. Format numbers clearly and consistently.',
    ].join('\n');

    if (operationHint.includes('aggregation')) {
      return (
        base +
        '\n\nThis query likely involves AGGREGATION (sum, average, max, min, count). ' +
        'Identify the correct numeric column(s) and compute the requested aggregate. ' +
        'State the result clearly with the column name and value.'
      );
    }

    if (operationHint.includes('filter')) {
      return (
        base +
        '\n\nThis query likely involves FILTERING data. ' +
        'Identify the relevant rows matching the criteria and list them. ' +
        'Include all relevant column values for each matching row.'
      );
    }

    if (operationHint.includes('comparison')) {
      return (
        base +
        '\n\nThis query likely involves COMPARING data across rows or columns. ' +
        'Identify the items being compared and highlight the differences. ' +
        'Present comparisons clearly with before/after or side-by-side values.'
      );
    }

    return base;
  }

  private buildUserPrompt(question: string, context: string): string {
    return [
      '## Document Context',
      '',
      context,
      '',
      '---',
      '',
      '## Question',
      '',
      question,
      '',
      '---',
      '',
      'Please answer the question using the context above.',
    ].join('\n');
  }

  // ── Private: context builders ──

  private buildContext(results: SearchResult[], mode: QAMode): string {
    const parts: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const ev = r.evidence;

      // Source header
      const sourceParts: string[] = [];
      sourceParts.push(`[${i + 1}]`);
      sourceParts.push(`File: ${ev.fileName}`);
      if (ev.pageNumber !== undefined) sourceParts.push(`Page: ${ev.pageNumber}`);
      if (ev.sectionTitle) sourceParts.push(`Section: ${ev.sectionTitle}`);
      if (r.chunk.chunkType === 'table') sourceParts.push(`(Table)`);
      if (r.chunk.chunkType === 'image') sourceParts.push(`(Image OCR)`);
      sourceParts.push(`Score: ${r.score.toFixed(3)}`);

      parts.push(sourceParts.join(' | '));

      // Content (truncated if conversational to fit more sources)
      const maxContentLen = mode === 'precise' ? 2000 : 1000;
      const content =
        r.chunk.content.length > maxContentLen
          ? r.chunk.content.slice(0, maxContentLen) + '…'
          : r.chunk.content;
      parts.push(content);
      parts.push('');
    }

    return parts.join('\n');
  }

  private buildTableContext(results: SearchResult[]): string {
    // Give the LLM full table content (including CSV) for accurate analysis
    const parts: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const m = r.chunk.metadata;

      parts.push(`## Table ${i + 1}`);
      parts.push(`- Source: ${m.fileName}`);
      if (m.pageNumber !== undefined) parts.push(`- Page: ${m.pageNumber}`);
      if (m.tableId) parts.push(`- Table ID: ${m.tableId}`);
      parts.push(`- Relevance score: ${r.score.toFixed(3)}`);
      parts.push('');
      parts.push(r.chunk.content); // Full table content
      parts.push('');
    }

    return parts.join('\n');
  }

  // ── Private: LLM call ──

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    temperature: number
  ): Promise<{ answerText: string; inputTokens: number; outputTokens: number }> {
    if (!this.apiKey) {
      throw new Error(
        '[DocumentQA] No API key configured. Set DEEPSEEK_API_KEY environment variable or pass apiKey in constructor options.'
      );
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const inputTokensEst = estimateTokens(systemPrompt) + estimateTokens(userPrompt);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          temperature,
          max_tokens: this.options.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(
          `[DocumentQA] LLM API error ${response.status}: ${errorBody}`
        );
      }

      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const answerText =
        data.choices?.[0]?.message?.content?.trim() || '(no response from model)';

      // Use actual token counts if provided, otherwise estimate
      const inputTokens = data.usage?.prompt_tokens ?? inputTokensEst;
      const outputTokens = data.usage?.completion_tokens ?? estimateTokens(answerText);

      return { answerText, inputTokens, outputTokens };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(
          `[DocumentQA] LLM request timed out after ${this.options.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Private: confidence scoring ──

  private computeConfidence(
    results: SearchResult[],
    evidence: EvidenceItem[],
    answerText: string,
    mode: QAMode
  ): number {
    let score = 0;
    const weights = {
      retrievalQuality: 0.3,
      evidenceCount: 0.2,
      answerLength: 0.1,
      retrievalScore: 0.4,
    };

    // 1. Retrieval quality: average score of top results
    if (results.length > 0) {
      const avgScore =
        results.reduce((sum, r) => sum + r.score, 0) / results.length;
      score += weights.retrievalScore * avgScore;
    }

    // 2. Number of evidence items (more evidence = higher confidence, to a point)
    const evidenceWeight = Math.min(evidence.length / 5, 1); // saturates at 5
    score += weights.evidenceCount * evidenceWeight;

    // 3. Answer length (very short answers = likely "not found")
    const contentLen = answerText.length;
    if (contentLen > 50) {
      score += weights.answerLength * Math.min(contentLen / 200, 1);
    }

    // 4. Check if answer contains source references (for precise mode)
    if (mode === 'precise') {
      const hasSourceRef =
        /\[.*?\]|section|page|table|source|according to/i.test(answerText);
      score += weights.retrievalQuality * (hasSourceRef ? 1 : 0.3);
    }

    return Math.min(Math.max(score, 0), 1);
  }
}
