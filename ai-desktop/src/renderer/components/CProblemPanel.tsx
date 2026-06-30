/**
 * CProblemPanel — End-to-end math modeling C problem workflow.
 *
 * Workflow:
 *  1. Upload PDF + attachments → parse problem structure
 *  2. View extracted data fields, constraints, evaluation metrics
 *  3. Generate Python analysis code → execute → view charts
 *  4. Generate LaTeX paper → compile → preview/download
 *
 * States: idle → parsing → code_generating → code_running → paper_writing → done
 */
import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import {
  FileText,
  Upload,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Eye,
  Download,
  Code2,
  BarChart3,
  FileCode2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Settings,
  FileSpreadsheet,
} from 'lucide-react';
import type { CProblemParsed, CProblem, CDataField, CAttachment } from '../../main/document-pipeline/types';

type WorkflowStatus =
  | 'idle'
  | 'uploading'
  | 'parsing'
  | 'parsed'
  | 'code_generating'
  | 'code_running'
  | 'code_done'
  | 'paper_writing'
  | 'done'
  | 'error';

interface WorkflowState {
  status: WorkflowStatus;
  error?: string;
  parsedData?: CProblemParsed;
  generatedCode?: string;
  codeOutput?: string;
  charts?: { name: string; path: string; type: string }[];
  paperTex?: string;
  paperPdf?: string;
  logs: string[];
}

// ── Section ──

function Section({ title, icon: Icon, defaultOpen, children }: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border border-border-muted rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-muted hover:bg-surface-hover text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Icon className="w-3.5 h-3.5 text-accent" />
        <span className="text-xs font-medium">{title}</span>
      </button>
      {open && <div className="px-3 py-2">{children}</div>}
    </div>
  );
}

// ── Badge ──

function Badge({ label, color }: { label: string; color?: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-full ${
      color || 'bg-surface-muted text-text-muted'
    }`}>
      {label}
    </span>
  );
}

// ── Main Component ──

export function CProblemPanel() {
  const { t } = useTranslation();
  const { invoke } = useIPC();

  const [state, setState] = useState<WorkflowState>({
    status: 'idle',
    logs: [],
  });
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setState((prev) => ({ ...prev, logs: [...prev.logs, `[${new Date().toLocaleTimeString()}] ${msg}`] }));
  }, []);

  // ── Step 1: Select PDF ──

  const handleSelectPdf = useCallback(async () => {
    try {
      const result = await invoke<{ filePath: string } | null>({
        type: 'dialog.selectPdf' as never,
        payload: {},
      } as never);
      if (result?.filePath) {
        setPdfPath(result.filePath);
        addLog(`Selected PDF: ${result.filePath}`);
      }
    } catch (err) {
      addLog(`Select PDF failed: ${err}`);
    }
  }, [invoke, addLog]);

  // ── Step 2: Select attachments ──

  const handleSelectAttachments = useCallback(async () => {
    try {
      const paths = await invoke<string[]>({
        type: 'dialog.selectAttachments' as never,
        payload: {},
      } as never);
      if (paths && paths.length > 0) {
        setAttachmentPaths((prev) => [...prev, ...paths]);
        addLog(`Added ${paths.length} attachment(s)`);
      }
    } catch (err) {
      addLog(`Select attachments failed: ${err}`);
    }
  }, [invoke, addLog]);

  // ── Step 3: Parse PDF ──

  const handleParsePdf = useCallback(async () => {
    if (!pdfPath) return;
    setState((s) => ({ ...s, status: 'parsing', error: undefined }));
    addLog('Parsing problem PDF...');

    try {
      const result = await invoke<CProblemParsed>({
        type: 'cproblem.parsePdf' as never,
        payload: { pdfPath },
      } as never);
      setState((s) => ({ ...s, status: 'parsed', parsedData: result }));
      addLog(`Parsed: ${result.title} (${result.problems.length} sub-problems, ${result.dataFields.length} data fields, ${result.attachments.length} attachments)`);
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: String(err) }));
      addLog(`Parse failed: ${err}`);
    }
  }, [pdfPath, invoke, addLog]);

  // ── Step 4: Generate & run code ──

  const handleGenerateCode = useCallback(async () => {
    setState((s) => ({ ...s, status: 'code_generating', error: undefined }));
    addLog('Generating Python analysis code...');

    try {
      const result = await invoke<{ code: string }>({
        type: 'cproblem.generateCode' as never,
        payload: { parsedData: state.parsedData, attachmentPaths },
      } as never);
      setState((s) => ({ ...s, status: 'code_generating', generatedCode: result.code }));
      addLog('Code generated.');
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: String(err) }));
      addLog(`Code generation failed: ${err}`);
    }
  }, [state.parsedData, attachmentPaths, invoke, addLog]);

  const handleRunCode = useCallback(async () => {
    if (!state.generatedCode) return;
    setState((s) => ({ ...s, status: 'code_running', error: undefined }));
    addLog('Running analysis code...');

    try {
      const result = await invoke<{
        output: string;
        charts: { name: string; path: string; type: string }[];
      }>({
        type: 'cproblem.runCode' as never,
        payload: { code: state.generatedCode },
      } as never);
      setState((s) => ({
        ...s,
        status: 'code_done',
        codeOutput: result.output,
        charts: result.charts,
      }));
      addLog(`Code executed. ${result.charts.length} charts generated.`);
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: String(err) }));
      addLog(`Code execution failed: ${err}`);
    }
  }, [state.generatedCode, invoke, addLog]);

  // ── Step 5: Generate LaTeX ──

  const handleGeneratePaper = useCallback(async () => {
    setState((s) => ({ ...s, status: 'paper_writing', error: undefined }));
    addLog('Generating LaTeX paper...');

    try {
      const result = await invoke<{ tex: string; pdfPath?: string }>({
        type: 'cproblem.generatePaper' as never,
        payload: {
          parsedData: state.parsedData,
          codeOutput: state.codeOutput,
          charts: state.charts,
        },
      } as never);
      setState((s) => ({ ...s, status: 'done', paperTex: result.tex, paperPdf: result.pdfPath }));
      addLog(`Paper generated. PDF: ${result.pdfPath || '(compile pending)'}`);
    } catch (err) {
      setState((s) => ({ ...s, status: 'error', error: String(err) }));
      addLog(`Paper generation failed: ${err}`);
    }
  }, [state.parsedData, state.codeOutput, state.charts, invoke, addLog]);

  // ── Status indicator ──

  const statusConfig: Record<WorkflowStatus, { icon: React.ReactNode; color: string; label: string }> = {
    idle: { icon: <Settings className="w-4 h-4" />, color: 'text-text-muted', label: 'Ready' },
    uploading: { icon: <Upload className="w-4 h-4 animate-pulse" />, color: 'text-info', label: 'Uploading' },
    parsing: { icon: <Loader2 className="w-4 h-4 animate-spin" />, color: 'text-info', label: 'Parsing PDF' },
    parsed: { icon: <CheckCircle2 className="w-4 h-4" />, color: 'text-green-500', label: 'Parsed' },
    code_generating: { icon: <Loader2 className="w-4 h-4 animate-spin" />, color: 'text-info', label: 'Generating Code' },
    code_running: { icon: <Loader2 className="w-4 h-4 animate-spin" />, color: 'text-info', label: 'Running Code' },
    code_done: { icon: <CheckCircle2 className="w-4 h-4" />, color: 'text-green-500', label: 'Code Done' },
    paper_writing: { icon: <Loader2 className="w-4 h-4 animate-spin" />, color: 'text-info', label: 'Writing Paper' },
    done: { icon: <CheckCircle2 className="w-4 h-4" />, color: 'text-green-500', label: 'Complete' },
    error: { icon: <XCircle className="w-4 h-4" />, color: 'text-red-500', label: 'Error' },
  };

  const sc = statusConfig[state.status];

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div className="flex items-center gap-2">
          <FileCode2 className="w-5 h-5 text-accent" />
          <h2 className="text-sm font-semibold">{t('cproblem.title', 'Math Modeling C Problem')}</h2>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={sc.color + ' flex items-center gap-1'}>
            {sc.icon}
            {sc.label}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── Input Section ── */}
        <Section title={t('cproblem.input', '1. Input Files')} icon={Upload}>
          <div className="space-y-2">
            {/* PDF */}
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent/90 flex items-center gap-1.5"
                onClick={handleSelectPdf}
              >
                <FileText className="w-3.5 h-3.5" />
                {t('cproblem.selectPdf', 'Select Problem PDF')}
              </button>
              {pdfPath && (
                <span className="text-xs text-text-muted truncate max-w-[200px]" title={pdfPath}>
                  {pdfPath.split(/[/\\]/).pop()}
                </span>
              )}
            </div>

            {/* Attachments */}
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-xs border border-border-muted rounded-md hover:bg-surface-hover flex items-center gap-1.5"
                onClick={handleSelectAttachments}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                {t('cproblem.selectAttachments', 'Add Attachments')}
              </button>
              {attachmentPaths.length > 0 && (
                <span className="text-xs text-text-muted">{attachmentPaths.length} files</span>
              )}
            </div>

            {/* Parse button */}
            <button
              className="w-full px-3 py-2 text-xs bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 flex items-center justify-center gap-1.5"
              disabled={!pdfPath || state.status === 'parsing'}
              onClick={handleParsePdf}
            >
              <Play className="w-3.5 h-3.5" />
              {t('cproblem.parse', 'Parse & Analyze')}
            </button>
          </div>
        </Section>

        {/* ── Parse Results ── */}
        {state.parsedData && (
          <>
            <Section title={t('cproblem.parseResult', '2. Parse Results')} icon={BarChart3}>
              <div className="space-y-2 text-xs">
                <div>
                  <span className="font-medium">{t('cproblem.title', 'Title')}: </span>
                  {state.parsedData.title}
                </div>
                <div>
                  <span className="font-medium">{t('cproblem.background', 'Background')}: </span>
                  <span className="text-text-muted">{state.parsedData.background.slice(0, 200)}...</span>
                </div>

                {/* Sub-problems */}
                <div>
                  <span className="font-medium">{t('cproblem.subProblems', 'Problems')} ({state.parsedData.problems.length}):</span>
                  <div className="mt-1 space-y-1.5">
                    {state.parsedData.problems.map((p: CProblem, i: number) => (
                      <div key={i} className="p-2 bg-surface-muted rounded text-xs">
                        <div className="font-medium">Q{p.index}: {p.description.slice(0, 120)}</div>
                        <div className="text-text-muted mt-0.5">Target: {p.target}</div>
                        {p.solutionHint && (
                          <div className="text-info mt-0.5">Hint: {p.solutionHint}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Data fields */}
                <div>
                  <span className="font-medium">{t('cproblem.dataFields', 'Data Fields')} ({state.parsedData.dataFields.length}):</span>
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    {state.parsedData.dataFields.map((f: CDataField, i: number) => (
                      <div key={i} className="flex items-center gap-1.5 p-1">
                        <Badge label={f.type} color="bg-accent/10 text-accent" />
                        <span>{f.name}</span>
                        {f.unit && <span className="text-text-muted">({f.unit})</span>}
                        {f.missingRate > 0 && (
                          <span className="text-warning text-[10px]">{ (f.missingRate * 100).toFixed(0)}% missing</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Constraints & Metrics */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="font-medium">{t('cproblem.constraints', 'Constraints')}:</span>
                    <ul className="list-disc list-inside text-text-muted">
                      {state.parsedData.constraints.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                  <div>
                    <span className="font-medium">{t('cproblem.evalMetrics', 'Eval Metrics')}:</span>
                    <ul className="list-disc list-inside text-text-muted">
                      {state.parsedData.evaluationMetrics.map((m, i) => <li key={i}>{m}</li>)}
                    </ul>
                  </div>
                </div>

                {/* Attachments */}
                {state.parsedData.attachments.length > 0 && (
                  <div>
                    <span className="font-medium">{t('cproblem.attachments', 'Attachments')}:</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {state.parsedData.attachments.map((a: CAttachment, i: number) => (
                        <span key={i} className="px-2 py-0.5 rounded bg-surface-hover text-xs">
                          {a.fileName} <span className="text-text-muted">({a.fileType})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            {/* ── Code Generation ── */}
            <Section title={t('cproblem.code', '3. Analysis Code')} icon={Code2}>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <button
                    className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5"
                    disabled={state.status === 'code_generating' || state.status === 'code_running'}
                    onClick={handleGenerateCode}
                  >
                    <Code2 className="w-3.5 h-3.5" />
                    {t('cproblem.generateCode', 'Generate Code')}
                  </button>
                  {state.generatedCode && (
                    <button
                      className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5"
                      disabled={state.status === 'code_running'}
                      onClick={handleRunCode}
                    >
                      <Play className="w-3.5 h-3.5" />
                      {t('cproblem.runCode', 'Run Code')}
                    </button>
                  )}
                </div>

                {state.generatedCode && (
                  <pre className="text-xs bg-surface-muted rounded p-2 max-h-48 overflow-auto font-mono">
                    {state.generatedCode}
                  </pre>
                )}

                {state.codeOutput && (
                  <div>
                    <span className="text-xs font-medium">{t('cproblem.output', 'Output')}:</span>
                    <pre className="text-xs bg-surface-muted rounded p-2 max-h-32 overflow-auto font-mono mt-1 whitespace-pre-wrap">
                      {state.codeOutput}
                    </pre>
                  </div>
                )}

                {state.charts && state.charts.length > 0 && (
                  <div>
                    <span className="text-xs font-medium">{t('cproblem.charts', 'Charts')} ({state.charts.length}):</span>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {state.charts.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5 px-2 py-1 bg-surface-muted rounded text-xs">
                          <BarChart3 className="w-3 h-3 text-accent" />
                          <span>{c.name}</span>
                          <span className="text-text-muted">({c.type})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            {/* ── Paper Generation ── */}
            <Section title={t('cproblem.paper', '4. LaTeX Paper')} icon={FileText}>
              <div className="space-y-2">
                <button
                  className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5"
                  disabled={!state.generatedCode || state.status === 'paper_writing' || state.status === 'done'}
                  onClick={handleGeneratePaper}
                >
                  {state.status === 'paper_writing' ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <FileText className="w-3.5 h-3.5" />
                  )}
                  {t('cproblem.generatePaper', 'Generate LaTeX Paper')}
                </button>

                {state.paperTex && (
                  <div>
                    <span className="text-xs font-medium">LaTeX Source:</span>
                    <pre className="text-xs bg-surface-muted rounded p-2 max-h-48 overflow-auto font-mono mt-1">
                      {state.paperTex.slice(0, 3000)}
                    </pre>
                  </div>
                )}

                {state.paperPdf && (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    <span className="text-xs text-green-600">PDF compiled successfully</span>
                    <button className="px-2 py-1 text-xs border border-border-muted rounded hover:bg-surface-hover flex items-center gap-1">
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                    <button className="px-2 py-1 text-xs border border-border-muted rounded hover:bg-surface-hover flex items-center gap-1">
                      <Download className="w-3 h-3" /> Download
                    </button>
                  </div>
                )}
              </div>
            </Section>
          </>
        )}

        {/* ── Logs ── */}
        {state.logs.length > 0 && (
          <Section title={t('cproblem.logs', 'Logs')} icon={AlertCircle} defaultOpen={false}>
            <pre className="text-[10px] font-mono text-text-muted max-h-48 overflow-auto whitespace-pre-wrap">
              {state.logs.join('\n')}
            </pre>
          </Section>
        )}

        {/* ── Error ── */}
        {state.error && (
          <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-2">
            <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <span className="text-xs text-red-700 dark:text-red-300">{state.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
