/**
 * LLM Wiki Builder — generates structured WikiCards from parsed documents.
 *
 * Uses the DeepSeek LLM to produce summaries, extract key concepts, and
 * build section-level wikis. Falls back to template-based extraction when
 * the LLM is unavailable. Caches results per document.
 */

import type {
  DocumentMeta,
  DocumentSection,
  WikiCard,
  WikiConcept,
  WikiSection,
  CrossDocRef,
} from './types';
import { log, logWarn, logError } from '../utils/logger';


// ── Options ──

export interface LLMWikiOptions {
  /** DeepSeek API base URL (default https://api.deepseek.com). */
  baseUrl: string;
  /** Model name (default deepseek-v4-pro). */
  model: string;
  /** API key. Falls back to DEEPSEEK_API_KEY env var. */
  apiKey?: string;
  /** Max tokens for LLM responses (default 4096). */
  maxTokens: number;
  /** Request timeout in ms (default 90000). */
  timeoutMs: number;
  /** Temperature for LLM (default 0.2 for structured output). */
  temperature: number;
  /** Whether to cache generated WikiCards (default true). */
  useCache: boolean;
}

const DEFAULT_OPTIONS: LLMWikiOptions = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  maxTokens: 4096,
  timeoutMs: 90_000,
  temperature: 0.2,
  useCache: true,
};

// ── Simple token estimator ──

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.5 + nonCjk * 0.3));
}

// ── JSON extraction from LLM response ──

function extractJsonBlock(text: string): string {
  // Try to find a JSON code block first
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch) return fencedMatch[1].trim();

  // Try to find content between { and } (outermost object)
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return text.trim();
}

// ── LLMWikiBuilder ──

export class LLMWikiBuilder {
  private options: LLMWikiOptions;
  private apiKey: string;
  private cache: Map<string, WikiCard>;
  private llmAvailable: boolean | null; // null = not checked yet

  constructor(options?: Partial<LLMWikiOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.apiKey =
      this.options.apiKey ||
      process.env.DEEPSEEK_API_KEY ||
      '';
    this.cache = this.options.useCache ? new Map() : (new Map() as Map<string, WikiCard>);
    this.llmAvailable = null;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    this.options.apiKey = key;
  }

  // ── Public API ──

  /**
   * Build (or retrieve cached) WikiCard for a document.
   */
  async buildWikiCard(doc: DocumentMeta): Promise<WikiCard> {
    // Return cached card if available
    if (this.options.useCache) {
      const cached = this.cache.get(doc.id);
      if (cached) {
        log(`[LLMWiki] Returning cached wiki card for "${doc.fileName}"`);
        return cached;
      }
    }

    log(`[LLMWiki] Building wiki card for "${doc.fileName}" (${doc.id})`);

    try {
      // Check LLM availability
      const llmOk = await this.checkLLMAvailability();

      let wikiCard: WikiCard;

      if (llmOk) {
        wikiCard = await this.buildWithLLM(doc);
      } else {
        logWarn('[LLMWiki] LLM unavailable, using template-based extraction');
        wikiCard = this.buildFromTemplate(doc);
      }

      // Cache
      if (this.options.useCache) {
        this.cache.set(doc.id, wikiCard);
      }

      return wikiCard;
    } catch (err) {
      logError(`[LLMWiki] Failed to build wiki card for "${doc.fileName}":`, err);

      // Last resort: template fallback
      const fallback = this.buildFromTemplate(doc);
      if (this.options.useCache) {
        this.cache.set(doc.id, fallback);
      }
      return fallback;
    }
  }

  /**
   * Find cross-references between a list of documents.
   * Returns a map of document ID to its list of cross-references to other docs.
   */
  async findCrossReferences(
    docs: DocumentMeta[]
  ): Promise<Map<string, CrossDocRef[]>> {
    log(`[LLMWiki] Finding cross-references among ${docs.length} documents`);

    const result = new Map<string, CrossDocRef[]>();

    if (docs.length < 2) {
      for (const doc of docs) {
        result.set(doc.id, []);
      }
      return result;
    }

    const llmOk = await this.checkLLMAvailability();

    if (llmOk) {
      try {
        const llmRefs = await this.findCrossRefsWithLLM(docs);
        for (const [docId, refs] of llmRefs) {
          result.set(docId, refs);
        }
        return result;
      } catch (err) {
        logError('[LLMWiki] LLM cross-reference failed, using template fallback:', err);
      }
    }

    // Template-based cross-references
    return this.findCrossRefsFromTemplate(docs);
  }

  /**
   * Get a cached WikiCard by document ID.
   */
  getCachedWikiCard(documentId: string): WikiCard | undefined {
    return this.cache.get(documentId);
  }

  /**
   * Invalidate the cache for a specific document or the entire cache.
   */
  invalidateCache(documentId?: string): void {
    if (documentId) {
      this.cache.delete(documentId);
    } else {
      this.cache.clear();
    }
    log(`[LLMWiki] Cache invalidated${documentId ? ` for ${documentId}` : ' (all)'}`);
  }

  /**
   * Return the number of cached wiki cards.
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  // ── Private: LLM availability check ──

  private async checkLLMAvailability(): Promise<boolean> {
    if (this.llmAvailable !== null) return this.llmAvailable;

    if (!this.apiKey) {
      this.llmAvailable = false;
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(`${this.options.baseUrl}/v1/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.llmAvailable = response.ok;

      if (response.ok) {
        log('[LLMWiki] LLM API is available');
      } else {
        logWarn(`[LLMWiki] LLM API returned ${response.status}, falling back to template mode`);
      }
    } catch {
      this.llmAvailable = false;
      logWarn('[LLMWiki] LLM API unreachable, falling back to template mode');
    }

    return this.llmAvailable;
  }

  // ── Private: LLM-based wiki generation ──

  private async buildWithLLM(doc: DocumentMeta): Promise<WikiCard> {
    const startTime = Date.now();

    // Build the full document context for the LLM
    const docContext = this.buildDocumentContext(doc);

    // 1. Generate overall summary and title
    const overviewPrompt = this.buildOverviewPrompt(docContext);
    const overviewResult = await this.callLLM(overviewPrompt);
    const overview = this.parseStructuredResponse<{
      title: string;
      summary: string;
      keyConcepts: { name: string; description: string }[];
    }>(overviewResult);

    // 2. Generate per-section wikis
    const sections = doc.sections ?? [];
    const wikiSections: WikiSection[] = [];

    // Batch sections to reduce API calls (up to 3 sections per call)
    const batchSize = 3;
    for (let i = 0; i < sections.length; i += batchSize) {
      const batch = sections.slice(i, i + batchSize);
      const sectionsPrompt = this.buildSectionsPrompt(doc, batch);
      const sectionsResult = await this.callLLM(sectionsPrompt);
      const parsed = this.parseStructuredResponse<{
        sections: {
          title: string;
          level: number;
          summary: string;
          keyPoints: string[];
          pageStart: number;
          pageEnd: number;
        }[];
      }>(sectionsResult);

      if (parsed?.sections) {
        for (const s of parsed.sections) {
          wikiSections.push({
            title: s.title,
            level: s.level,
            summary: s.summary,
            pageRange: [s.pageStart, s.pageEnd],
            keyPoints: s.keyPoints ?? [],
          });
        }
      }
    }

    // If LLM missed some sections, fill from template
    if (wikiSections.length < sections.length) {
      const covered = new Set(wikiSections.map((s) => s.title));
      for (const sec of sections) {
        if (!covered.has(sec.title)) {
          wikiSections.push(this.buildWikiSectionFromTemplate(sec));
        }
      }
    }

    // 3. Build WikiConcepts with chunk IDs
    const concepts: WikiConcept[] = (overview?.keyConcepts ?? []).map((kc) => ({
      name: kc.name,
      description: kc.description,
      relatedChunks: [] as string[], // chunks will be linked by the indexer
    }));

    const wikiCard: WikiCard = {
      title: overview?.title ?? doc.fileName,
      summary: overview?.summary ?? this.generateTemplateSummary(doc),
      keyConcepts: concepts,
      structure: wikiSections.sort((a, b) => a.pageRange[0] - b.pageRange[0]),
      crossRefs: [],
    };

    const elapsed = Date.now() - startTime;
    log(
      `[LLMWiki] Built wiki card for "${doc.fileName}" in ${elapsed}ms ` +
      `(${wikiSections.length} sections, ${concepts.length} concepts)`
    );

    return wikiCard;
  }

  private buildDocumentContext(doc: DocumentMeta): string {
    const parts: string[] = [];

    parts.push(`File: ${doc.fileName}`);
    parts.push(`Type: ${doc.fileType}`);
    parts.push(`Pages: ${doc.pageCount ?? 'unknown'}`);
    parts.push('');

    if (doc.sections && doc.sections.length > 0) {
      parts.push('## Sections');
      parts.push('');
      for (const sec of doc.sections) {
        parts.push(`### ${sec.title} (Level ${sec.level}, Pages ${sec.pageStart}-${sec.pageEnd})`);
        // Provide first ~1500 chars of content
        const truncated =
          sec.content.length > 1500
            ? sec.content.slice(0, 1500) + '…'
            : sec.content;
        parts.push(truncated);
        parts.push('');
      }
    }

    if (doc.tables && doc.tables.length > 0) {
      parts.push('## Tables');
      parts.push(`Total: ${doc.tables.length} table(s)`);
      for (const t of doc.tables) {
        const label = t.caption ?? `Table on page ${t.page}`;
        parts.push(`- ${label}`);
      }
      parts.push('');
    }

    if (doc.images && doc.images.length > 0) {
      parts.push('## Images');
      parts.push(`Total: ${doc.images.length} image(s)`);
      for (const img of doc.images) {
        const label = img.caption ?? `Image on page ${img.page}`;
        const hasOcr = img.ocrText ? ' (with OCR)' : '';
        parts.push(`- ${label}${hasOcr}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private buildOverviewPrompt(docContext: string): string {
    return [
      'You are a document analysis expert. Analyze the following document and produce a structured summary.',
      '',
      '## Instructions',
      '1. Generate a concise, descriptive title that reflects the document content.',
      '2. Write a comprehensive summary (150-300 words) covering the main topic, purpose, and key findings.',
      '3. Extract 3-8 key concepts/terms with brief descriptions.',
      '',
      '## Output Format',
      'Respond with valid JSON only, using this exact structure:',
      '{',
      '  "title": "Document title",',
      '  "summary": "Comprehensive summary text...",',
      '  "keyConcepts": [',
      '    { "name": "Concept name", "description": "Brief description" }',
      '  ]',
      '}',
      '',
      '## Document',
      docContext,
      '',
      'Respond with JSON only. Do not include any text outside the JSON object.',
    ].join('\n');
  }

  private buildSectionsPrompt(
    doc: DocumentMeta,
    sections: DocumentSection[]
  ): string {
    const sectionsText = sections
      .map((sec) => {
        const preview =
          sec.content.length > 800
            ? sec.content.slice(0, 800) + '…'
            : sec.content;
        return `### ${sec.title}\nLevel: ${sec.level}\nPages: ${sec.pageStart}-${sec.pageEnd}\nContent:\n${preview}`;
      })
      .join('\n\n---\n\n');

    return [
      'You are a document analysis expert. Summarize the following document sections.',
      '',
      '## Instructions',
      'For each section, provide:',
      '- A 2-4 sentence summary of the content',
      '- 2-5 key points (concise bullet-worthy items)',
      '',
      '## Output Format',
      'Respond with valid JSON only:',
      '{',
      '  "sections": [',
      '    {',
      '      "title": "Section title",',
      '      "level": <heading level number>,',
      '      "summary": "2-4 sentence summary",',
      '      "keyPoints": ["Point 1", "Point 2"],',
      '      "pageStart": <page number>,',
      '      "pageEnd": <page number>',
      '    }',
      '  ]',
      '}',
      '',
      '## Document: ' + doc.fileName,
      '',
      sectionsText,
      '',
      'Respond with JSON only. Do not include any text outside the JSON object.',
    ].join('\n');
  }

  // ── Private: LLM-based cross-reference detection ──

  private async findCrossRefsWithLLM(
    docs: DocumentMeta[]
  ): Promise<Map<string, CrossDocRef[]>> {
    const result = new Map<string, CrossDocRef[]>();

    for (const doc of docs) {
      result.set(doc.id, []);
    }

    // Build a digest for each document (fileName + summary lines)
    const docDigests = docs.map((doc) => {
      const sections = doc.sections ?? [];
      const titles = sections.slice(0, 10).map((s) => s.title).join(', ');
      return {
        id: doc.id,
        fileName: doc.fileName,
        digest: `File: ${doc.fileName}\nSections: ${titles}\nPages: ${doc.pageCount ?? '?'}`,
      };
    });

    // Compare each pair
    for (let i = 0; i < docDigests.length; i++) {
      for (let j = i + 1; j < docDigests.length; j++) {
        const a = docDigests[i];
        const b = docDigests[j];

        const prompt = [
          'Analyze the relationship between these two documents.',
          'If they are related (shared topic, one references the other, one builds on the other, etc.), describe the relationship.',
          'If they appear unrelated, respond with an empty array.',
          '',
          '## Document A',
          a.digest,
          '',
          '## Document B',
          b.digest,
          '',
          '## Output Format',
          'Respond with valid JSON only:',
          '{',
          '  "relations": [',
          '    {',
          '      "direction": "A_to_B" | "B_to_A" | "mutual",',
          '      "relation": "shared_topic" | "references" | "builds_on" | "complements" | "contrasts",',
          '      "description": "Brief relationship description"',
          '    }',
          '  ]',
          '}',
          '',
          'If unrelated, respond with { "relations": [] }.',
          'Respond with JSON only.',
        ].join('\n');

        try {
          const response = await this.callLLM(prompt);
          const parsed = this.parseStructuredResponse<{
            relations: {
              direction: string;
              relation: string;
              description: string;
            }[];
          }>(response);

          if (parsed?.relations && parsed.relations.length > 0) {
            for (const rel of parsed.relations) {
              if (rel.direction === 'A_to_B' || rel.direction === 'mutual') {
                const refs = result.get(a.id)!;
                refs.push({
                  targetDocId: b.id,
                  targetFileName: b.fileName,
                  relation: rel.relation,
                  description: rel.description,
                });
              }
              if (rel.direction === 'B_to_A' || rel.direction === 'mutual') {
                const refs = result.get(b.id)!;
                refs.push({
                  targetDocId: a.id,
                  targetFileName: a.fileName,
                  relation: rel.relation,
                  description: rel.description,
                });
              }
            }
          }
        } catch (err) {
          logWarn(
            `[LLMWiki] Skipping cross-ref for "${a.fileName}" vs "${b.fileName}":`,
            err
          );
        }
      }
    }

    return result;
  }

  // ── Private: LLM call ──

  private async callLLM(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('[LLMWiki] No API key configured');
    }

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
          messages: [
            {
              role: 'system',
              content:
                'You are a precise document analysis assistant. Always respond with valid, parseable JSON only. Do not include markdown, explanations, or any text outside the JSON object.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: this.options.temperature,
          max_tokens: this.options.maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`[LLMWiki] API error ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const text = data.choices?.[0]?.message?.content?.trim() || '';

      if (data.usage) {
        log(
          `[LLMWiki] Token usage — input: ${data.usage.prompt_tokens}, ` +
          `output: ${data.usage.completion_tokens}`
        );
      } else {
        log(`[LLMWiki] Estimated token usage — ${estimateTokens(prompt + text)} total`);
      }

      return text;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`[LLMWiki] Request timed out after ${this.options.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Private: structured JSON parsing ──

  private parseStructuredResponse<T>(text: string): T | null {
    try {
      const jsonText = extractJsonBlock(text);
      return JSON.parse(jsonText) as T;
    } catch (err) {
      logError('[LLMWiki] Failed to parse structured response:', err);
      logError('[LLMWiki] Raw response (first 500 chars):', text.slice(0, 500));
      return null;
    }
  }

  // ── Private: template-based fallback ──

  private buildFromTemplate(doc: DocumentMeta): WikiCard {
    log(`[LLMWiki] Building template wiki for "${doc.fileName}"`);

    const sections = doc.sections ?? [];
    const wikiSections = sections.map((s) =>
      this.buildWikiSectionFromTemplate(s)
    );

    const concepts: WikiConcept[] = this.extractConceptsFromTemplate(doc);
    const summary = this.generateTemplateSummary(doc);

    return {
      title: doc.fileName,
      summary,
      keyConcepts: concepts,
      structure: wikiSections,
      crossRefs: [],
    };
  }

  private generateTemplateSummary(doc: DocumentMeta): string {
    const parts: string[] = [];

    parts.push(`Document "${doc.fileName}" is a ${doc.fileType.toUpperCase()} file`);

    if (doc.pageCount) {
      parts.push(`with ${doc.pageCount} page(s)`);
    }

    const sections = doc.sections ?? [];
    if (sections.length > 0) {
      parts.push(`containing ${sections.length} major section(s):`);
      const sectionList = sections
        .slice(0, 8)
        .map((s) => `"${s.title}"`)
        .join(', ');
      parts.push(sectionList);
      if (sections.length > 8) {
        parts.push(`and ${sections.length - 8} more`);
      }
      parts.push('.');
    } else {
      parts.push('.');
    }

    if (doc.tables && doc.tables.length > 0) {
      parts.push(
        ` The document includes ${doc.tables.length} table(s)` +
        (doc.tables.some((t) => t.caption)
          ? ` (${doc.tables.filter((t) => t.caption).map((t) => t.caption).join('; ')})`
          : '') +
        '.'
      );
    }

    if (doc.images && doc.images.length > 0) {
      parts.push(
        ` It contains ${doc.images.length} image(s)` +
        (doc.images.some((i) => i.ocrText)
          ? ` (${doc.images.filter((i) => i.ocrText).length} with OCR text)`
          : '') +
        '.'
      );
    }

    return parts.join('');
  }

  private buildWikiSectionFromTemplate(section: DocumentSection): WikiSection {
    // Extract first sentence as summary
    const firstSentence = section.content.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0] ?? '';

    // Extract key points: first N sentences
    const sentences = section.content.match(/[^。！？.!?\n]+[。！？.!?]?/g) ?? [];
    const keyPoints = sentences
      .slice(0, 5)
      .map((s) => s.trim())
      .filter((s) => s.length > 10)
      .map((s) => (s.length > 150 ? s.slice(0, 150) + '…' : s));

    return {
      title: section.title,
      level: section.level,
      summary: firstSentence || `Section "${section.title}" spans pages ${section.pageStart}-${section.pageEnd}.`,
      pageRange: [section.pageStart, section.pageEnd],
      keyPoints,
    };
  }

  private extractConceptsFromTemplate(doc: DocumentMeta): WikiConcept[] {
    const concepts: WikiConcept[] = [];
    const seen = new Set<string>();

    // Extract capitalized terms, technical terms in parentheses, and heading keywords
    // from section titles
    for (const section of doc.sections ?? []) {
      const title = section.title;
      // Look for terms in parentheses (e.g., "CNN (Convolutional Neural Network)")
      const parenMatch = title.match(/\(([^)]+)\)/g);
      if (parenMatch) {
        for (const m of parenMatch) {
          const term = m.slice(1, -1).trim();
          if (term.length > 2 && term.length < 60 && !seen.has(term)) {
            seen.add(term);
            concepts.push({
              name: term,
              description: `Term referenced in section "${section.title}"`,
              relatedChunks: [],
            });
          }
        }
      }

      // Extract capitalized phrases (2+ words)
      const capsMatches = title.match(/\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+\b/g);
      if (capsMatches) {
        for (const m of capsMatches) {
          if (m.length > 3 && m.length < 60 && !seen.has(m)) {
            seen.add(m);
            concepts.push({
              name: m,
              description: `Concept referenced in section "${section.title}"`,
              relatedChunks: [],
            });
          }
        }
      }
    }

    // Extract terms from table captions
    for (const table of doc.tables ?? []) {
      if (table.caption && table.caption.length > 3 && !seen.has(table.caption)) {
        seen.add(table.caption);
        concepts.push({
          name: table.caption,
          description: `Table caption on page ${table.page}`,
          relatedChunks: [],
        });
      }
    }

    // Deduplicate: keep at most 10
    return concepts.slice(0, 10);
  }

  // ── Private: template-based cross-references ──

  private findCrossRefsFromTemplate(
    docs: DocumentMeta[]
  ): Map<string, CrossDocRef[]> {
    const result = new Map<string, CrossDocRef[]>();

    for (const doc of docs) {
      result.set(doc.id, []);
    }

    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i];
        const b = docs[j];

        // Check for shared section titles
        const aTitles = new Set((a.sections ?? []).map((s) => s.title.toLowerCase()));
        const bTitles = new Set((b.sections ?? []).map((s) => s.title.toLowerCase()));
        const shared: string[] = [];
        for (const t of aTitles) {
          if (bTitles.has(t)) shared.push(t);
        }

        // Check for file name mentions in content
        const aNameInB = this.documentMentionsOther(a, b);
        const bNameInA = this.documentMentionsOther(b, a);

        // Check for same file type
        const sameType = a.fileType === b.fileType;

        const aRefs = result.get(a.id)!;
        const bRefs = result.get(b.id)!;

        if (shared.length > 0) {
          aRefs.push({
            targetDocId: b.id,
            targetFileName: b.fileName,
            relation: 'shared_topic',
            description: `Shares section(s): ${shared.slice(0, 3).join(', ')}`,
          });
          bRefs.push({
            targetDocId: a.id,
            targetFileName: a.fileName,
            relation: 'shared_topic',
            description: `Shares section(s): ${shared.slice(0, 3).join(', ')}`,
          });
        }

        if (aNameInB) {
          bRefs.push({
            targetDocId: a.id,
            targetFileName: a.fileName,
            relation: 'references',
            description: `Mentions "${a.fileName}" in content`,
          });
        }

        if (bNameInA) {
          aRefs.push({
            targetDocId: b.id,
            targetFileName: b.fileName,
            relation: 'references',
            description: `Mentions "${b.fileName}" in content`,
          });
        }

        if (sameType && shared.length === 0 && !aNameInB && !bNameInA) {
          // Same type but no strong connection — mark as same category
          aRefs.push({
            targetDocId: b.id,
            targetFileName: b.fileName,
            relation: 'same_type',
            description: `Both are ${a.fileType} documents`,
          });
          bRefs.push({
            targetDocId: a.id,
            targetFileName: a.fileName,
            relation: 'same_type',
            description: `Both are ${b.fileType} documents`,
          });
        }
      }
    }

    return result;
  }

  /**
   * Check if document `needle` is mentioned by name in document `haystack`'s content.
   */
  private documentMentionsOther(
    needle: DocumentMeta,
    haystack: DocumentMeta
  ): boolean {
    const nameNoExt = needle.fileName.replace(/\.[^.]+$/, '');
    const searchTerms = [needle.fileName, nameNoExt].filter(
      (t) => t.length > 3
    );

    const allContent = [
      ...(haystack.sections ?? []).map((s) => s.content),
      ...(haystack.tables ?? []).map((t) => t.markdown + t.csv),
      ...(haystack.images ?? []).map((i) => i.ocrText ?? ''),
    ].join(' ');

    const lowerContent = allContent.toLowerCase();
    return searchTerms.some((term) => lowerContent.includes(term.toLowerCase()));
  }
}
