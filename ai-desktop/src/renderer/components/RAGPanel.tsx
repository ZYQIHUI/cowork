/**
 * RAGPanel — Document Parsing, Knowledge Base & Q&A Interface.
 *
 * Features:
 * - Upload and parse documents (PDF, DOCX, XLSX, CSV, images, etc.)
 * - View parsed content: sections, tables, images
 * - Build and browse LLM Wiki knowledge cards
 * - Ask questions with evidence-grounded answers
 */
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import {
  Upload,
  FileText,
  FileSpreadsheet,
  FileImage,
  File,
  Trash2,
  Send,
  BookOpen,
  BrainCircuit,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Database,
  Table2,
  MessageSquare,
  Eye,
} from 'lucide-react';

// ── Types ──

interface DocInfo {
  id: string;
  fileName: string;
  filePath: string;
  fileType: string;
  fileSize: number;
  pageCount?: number;
  parseStatus: 'pending' | 'parsing' | 'completed' | 'failed';
  parseError?: string;
  sections?: { id: string; title: string; level: number; content: string; pageStart: number; pageEnd: number }[];
  tables?: { id: string; page: number; caption?: string; headers: { text: string; level: number }[]; rows: string[][]; markdown: string }[];
  images?: { id: string; page: number; caption?: string; ocrText?: string }[];
  wikiCard?: { title: string; summary: string; keyConcepts: { name: string; description: string }[] };
}

interface QAItem {
  question: string;
  answer: string;
  evidence: { type: string; fileName: string; pageNumber?: number; excerpt: string }[];
  confidence: number;
}

// ── File type icon ──

function fileTypeIcon(fileType: string) {
  switch (fileType) {
    case 'pdf': return <FileText className="w-4 h-4 text-red-400" />;
    case 'excel':
    case 'csv': return <FileSpreadsheet className="w-4 h-4 text-green-400" />;
    case 'image': return <FileImage className="w-4 h-4 text-purple-400" />;
    default: return <File className="w-4 h-4 text-text-muted" />;
  }
}

function statusBadge(status: string) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
    case 'parsing':
      return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-500" />;
    default:
      return <Clock className="w-3.5 h-3.5 text-yellow-500" />;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Main Component ──

export function RAGPanel() {
  const { t } = useTranslation();
  const { invoke, isElectron } = useIPC();

  const [docs, setDocs] = useState<DocInfo[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'preview' | 'wiki' | 'qa'>('preview');
  const [loading, setLoading] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  // Q&A state
  const [question, setQuestion] = useState('');
  const [qaHistory, setQaHistory] = useState<QAItem[]>([]);
  const [qaLoading, setQaLoading] = useState(false);

  // Wiki state
  const [wikiLoading, setWikiLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogLines((p) => [...p, `[${ts}] ${msg}`]);
  }, []);

  // ── Load documents ──

  const loadDocs = useCallback(async () => {
    if (!isElectron) return;
    try {
      const result = await invoke<DocInfo[]>({
        type: 'rag.listDocuments' as never,
        payload: {} as never,
      } as never);
      if (Array.isArray(result)) setDocs(result);
    } catch (err) {
      log(`Failed to load documents: ${err}`);
    }
  }, [invoke, isElectron, log]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  // ── Upload document ──

  const handleUpload = useCallback(async () => {
    if (!isElectron) return;
    try {
      const fileResult = await invoke<{ filePath: string } | null>({
        type: 'rag.selectDocument' as never,
        payload: {} as never,
      } as never);
      if (!fileResult?.filePath) return;

      log(`Uploading: ${fileResult.filePath}`);
      setLoading(true);
      const doc = await invoke<DocInfo>({
        type: 'rag.uploadDocument' as never,
        payload: { filePath: fileResult.filePath } as never,
      } as never);
      if (doc) {
        log(`Parsed: ${doc.fileName} (${doc.sections?.length || 0} sections, ${doc.tables?.length || 0} tables)`);
        await loadDocs();
        setSelectedDocId(doc.id);
      }
    } catch (err) {
      log(`Upload failed: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [invoke, isElectron, log, loadDocs]);

  // ── Delete document ──

  const handleDelete = useCallback(async (docId: string) => {
    try {
      await invoke({
        type: 'rag.deleteDocument' as never,
        payload: { docId } as never,
      } as never);
      log('Document deleted');
      if (selectedDocId === docId) setSelectedDocId(null);
      await loadDocs();
    } catch (err) {
      log(`Delete failed: ${err}`);
    }
  }, [invoke, log, loadDocs, selectedDocId]);

  // ── Build wiki ──

  const handleBuildWiki = useCallback(async () => {
    if (!selectedDocId) return;
    setWikiLoading(true);
    try {
      const wiki = await invoke<DocInfo['wikiCard'] | null>({
        type: 'rag.buildWiki' as never,
        payload: { docId: selectedDocId } as never,
      } as never);
      if (wiki) {
        log(`Wiki built: ${wiki.title}`);
        await loadDocs();
      }
    } catch (err) {
      log(`Wiki build failed: ${err}`);
    } finally {
      setWikiLoading(false);
    }
  }, [invoke, log, loadDocs, selectedDocId]);

  // ── Ask question ──

  const handleAskQuestion = useCallback(async () => {
    if (!question.trim() || qaLoading) return;
    setQaLoading(true);
    const q = question.trim();
    setQuestion('');
    try {
      const result = await invoke<QAItem>({
        type: 'rag.askQuestion' as never,
        payload: { question: q, mode: 'precise' } as never,
      } as never);
      if (result) {
        setQaHistory((p) => [{ ...result, question: q }, ...p]);
        log(`Q: ${q} (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
      }
    } catch (err) {
      log(`Q&A failed: ${err}`);
    } finally {
      setQaLoading(false);
    }
  }, [question, qaLoading, invoke, log]);

  // ── Selected document ──

  const selectedDoc = docs.find((d) => d.id === selectedDocId);

  // ── Toggle section expand ──

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* ── Left Sidebar: Document List ── */}
      <div className="w-72 shrink-0 border-r border-border-subtle flex flex-col bg-surface-muted/50">
        <div className="p-3 border-b border-border-subtle">
          <button
            onClick={handleUpload}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-accent text-white hover:bg-accent-hover transition-colors text-sm font-medium disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            {t('rag.uploadDocument', 'Upload Document')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {docs.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-muted">
              <Database className="w-8 h-8 mx-auto mb-2 opacity-30" />
              {t('rag.noDocuments', 'No documents yet. Upload one to get started.')}
            </div>
          ) : (
            docs.map((doc) => (
              <div
                key={doc.id}
                onClick={() => {
                  setSelectedDocId(doc.id);
                  setActiveTab('preview');
                }}
                className={`p-3 border-b border-border-subtle cursor-pointer transition-colors hover:bg-surface-hover ${
                  selectedDocId === doc.id ? 'bg-accent/10 border-l-2 border-l-accent' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  {fileTypeIcon(doc.fileType)}
                  <span className="text-sm text-text-primary truncate flex-1">{doc.fileName}</span>
                  {statusBadge(doc.parseStatus)}
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-text-muted">
                    {formatSize(doc.fileSize)}
                    {doc.pageCount ? ` · ${doc.pageCount}p` : ''}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(doc.id); }}
                    className="p-0.5 rounded hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {doc.parseError && (
                  <p className="text-[10px] text-red-500 mt-1 truncate">{doc.parseError}</p>
                )}
              </div>
            ))
          )}
        </div>

        {/* Log output */}
        {logLines.length > 0 && (
          <div className="border-t border-border-subtle p-2 max-h-24 overflow-y-auto bg-surface-dark">
            {logLines.slice(-8).map((line, i) => (
              <p key={i} className="text-[10px] text-text-muted font-mono leading-relaxed">{line}</p>
            ))}
          </div>
        )}
      </div>

      {/* ── Main Content Area ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!selectedDoc ? (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            <div className="text-center space-y-3">
              <BookOpen className="w-12 h-12 mx-auto opacity-20" />
              <p className="text-sm">{t('rag.selectDocumentHint', 'Select a document or upload a new one')}</p>
            </div>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex items-center border-b border-border-subtle px-4 gap-1">
              {([
                ['preview', Eye, 'rag.preview'],
                ['wiki', BrainCircuit, 'rag.knowledgeBase'],
                ['qa', MessageSquare, 'rag.qa'],
              ] as const).map(([tab, Icon, labelKey]) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                    activeTab === tab
                      ? 'border-accent text-accent'
                      : 'border-transparent text-text-muted hover:text-text-secondary'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {t(labelKey, tab === 'preview' ? 'Preview' : tab === 'wiki' ? 'KB' : 'Q&A')}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* ── Preview Tab ── */}
              {activeTab === 'preview' && (
                <div className="space-y-4 max-w-3xl">
                  {/* Sections */}
                  {selectedDoc.sections && selectedDoc.sections.length > 0 ? (
                    selectedDoc.sections.map((section) => (
                      <div key={section.id} className="rounded-xl border border-border-subtle overflow-hidden">
                        <button
                          onClick={() => toggleSection(section.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 bg-surface-muted hover:bg-surface-hover transition-colors text-left"
                        >
                          {expandedSections.has(section.id) ? (
                            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
                          )}
                          <span className="text-sm font-medium text-text-primary">
                            {section.title || `Section ${section.id}`}
                          </span>
                          <span className="text-[10px] text-text-muted ml-auto">
                            p{section.pageStart}-{section.pageEnd}
                          </span>
                        </button>
                        {expandedSections.has(section.id) && (
                          <div className="px-4 py-3 text-sm text-text-secondary leading-relaxed whitespace-pre-wrap border-t border-border-subtle">
                            {section.content.substring(0, 2000)}
                            {section.content.length > 2000 && (
                              <span className="text-text-muted">... (truncated)</span>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-text-muted text-center py-8">
                      {selectedDoc.parseStatus === 'parsing'
                        ? t('rag.parsing', 'Parsing in progress...')
                        : selectedDoc.parseStatus === 'failed'
                          ? t('rag.parseFailed', 'Parse failed')
                          : t('rag.noContent', 'No parsed content available')}
                    </p>
                  )}

                  {/* Tables */}
                  {selectedDoc.tables && selectedDoc.tables.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                        <Table2 className="w-4 h-4" />
                        {t('rag.tables', 'Tables')} ({selectedDoc.tables.length})
                      </h3>
                      {selectedDoc.tables.map((table) => (
                        <div key={table.id} className="rounded-lg border border-border-subtle overflow-hidden">
                          <div className="px-3 py-1.5 bg-surface-muted text-xs text-text-muted">
                            Table {table.id} — p{table.page}
                            {table.caption && ` — ${table.caption}`}
                          </div>
                          <div className="p-2 overflow-x-auto">
                            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono">
                              {table.markdown.substring(0, 1500)}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Wiki / Knowledge Base Tab ── */}
              {activeTab === 'wiki' && (
                <div className="space-y-4 max-w-3xl">
                  {selectedDoc.wikiCard ? (
                    <>
                      <div className="rounded-xl border border-border-subtle p-4 bg-surface-muted/30">
                        <h3 className="text-base font-semibold text-text-primary">
                          {selectedDoc.wikiCard.title}
                        </h3>
                        <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                          {selectedDoc.wikiCard.summary}
                        </p>
                      </div>

                      {selectedDoc.wikiCard.keyConcepts && selectedDoc.wikiCard.keyConcepts.length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-text-primary mb-2">
                            {t('rag.keyConcepts', 'Key Concepts')}
                          </h4>
                          <div className="grid gap-2">
                            {selectedDoc.wikiCard.keyConcepts.map((c, i) => (
                              <div key={i} className="rounded-lg border border-border-subtle p-3">
                                <span className="text-sm font-medium text-accent">{c.name}</span>
                                <p className="text-xs text-text-muted mt-1">{c.description}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-8 space-y-3">
                      <BrainCircuit className="w-10 h-10 mx-auto opacity-20" />
                      <p className="text-sm text-text-muted">
                        {t('rag.noWiki', 'No knowledge card built yet')}
                      </p>
                      <button
                        onClick={handleBuildWiki}
                        disabled={wikiLoading}
                        className="px-4 py-2 rounded-xl bg-accent text-white text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
                      >
                        {wikiLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
                        ) : null}
                        {t('rag.buildWiki', 'Build Knowledge Card')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Q&A Tab ── */}
              {activeTab === 'qa' && (
                <div className="flex flex-col h-full max-w-3xl">
                  {/* Q&A History */}
                  <div className="flex-1 space-y-4 overflow-y-auto pb-4">
                    {qaHistory.length === 0 ? (
                      <p className="text-sm text-text-muted text-center py-8">
                        {t('rag.askQuestionHint', 'Ask a question about your documents')}
                      </p>
                    ) : (
                      qaHistory.map((item, i) => (
                        <div key={i} className="space-y-2">
                          {/* Question */}
                          <div className="flex items-start gap-2">
                            <span className="px-2 py-1 rounded-lg bg-accent/10 text-accent text-xs font-medium">
                              Q
                            </span>
                            <p className="text-sm text-text-primary">{item.question}</p>
                          </div>
                          {/* Answer */}
                          <div className="ml-6 rounded-xl border border-border-subtle p-3 bg-surface-muted/30">
                            <p className="text-sm text-text-secondary leading-relaxed">{item.answer}</p>
                            {/* Evidence */}
                            {item.evidence && item.evidence.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-border-subtle">
                                <span className="text-[10px] text-text-muted font-medium">
                                  {t('rag.evidence', 'Evidence')}:
                                </span>
                                <div className="mt-1 space-y-1">
                                  {item.evidence.map((ev, j) => (
                                    <div key={j} className="flex items-center gap-1 text-[10px] text-text-muted">
                                      <ExternalLink className="w-3 h-3" />
                                      <span>{ev.fileName}</span>
                                      {ev.pageNumber && <span>p{ev.pageNumber}</span>}
                                      <span className="text-accent truncate max-w-[200px]">"{ev.excerpt.substring(0, 80)}"</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {/* Confidence */}
                            <div className="mt-1 flex items-center gap-1">
                              <div className="flex-1 h-1 rounded-full bg-surface-hover">
                                <div
                                  className="h-1 rounded-full bg-accent transition-all"
                                  style={{ width: `${item.confidence * 100}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-text-muted">
                                {(item.confidence * 100).toFixed(0)}%
                              </span>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Q&A Input */}
                  <div className="border-t border-border-subtle pt-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAskQuestion(); }}
                        placeholder={t('rag.askPlaceholder', 'Ask a question about your documents...')}
                        className="flex-1 px-3 py-2 rounded-xl border border-border bg-background text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50"
                      />
                      <button
                        onClick={handleAskQuestion}
                        disabled={!question.trim() || qaLoading}
                        className="p-2 rounded-xl bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                      >
                        {qaLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
