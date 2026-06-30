/**
 * EvalPanel — Unified experiment evaluation dashboard.
 *
 * Shows three categories of metrics in one view:
 * 1. Coding Agent metrics (cache hit rate, task completion, latency, cost)
 * 2. RAG / Document metrics (parse success, recall@k, MRR, evidence, QA accuracy)
 * 3. Skill-based doc generation metrics (trigger accuracy, generation success,
 *    validation pass rate, token savings)
 */
import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import {
  BarChart3,
  Cpu,
  FileText,
  BrainCircuit,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Table2,
  Zap,
  Layers,
} from 'lucide-react';
import type { DocumentEvalResult, SkillEvalResult, CProblemEvalResult } from '../../main/document-pipeline/types';

// ── Helpers ──

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function statusIcon(passed: boolean) {
  return passed
    ? <CheckCircle2 className="w-4 h-4 text-green-500" />
    : <XCircle className="w-4 h-4 text-red-500" />;
}

// ── Metric row ──

function MetricRow({ label, value, suffix, color }: {
  label: string;
  value: React.ReactNode;
  suffix?: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs font-mono font-medium ${color || 'text-text-primary'}`}>
        {value}{suffix}
      </span>
    </div>
  );
}

// ── Section collapsible ──

function Section({ icon: Icon, title, defaultOpen, children }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border border-border-muted rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-muted hover:bg-surface-hover transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Icon className="w-4 h-4 text-accent" />
        <span className="text-sm font-medium">{title}</span>
      </button>
      {open && <div className="px-4 py-3 space-y-2">{children}</div>}
    </div>
  );
}

// ── Main component ──

export function EvalPanel() {
  const { t } = useTranslation();
  const cacheStats = useAppStore((s) => s.cacheStats);
  const sessionStates = useAppStore((s) => s.sessionStates);
  const sessions = useAppStore((s) => s.sessions);
  const { invoke } = useIPC();

  const [docEval, setDocEval] = useState<DocumentEvalResult | null>(null);
  const [skillEval, setSkillEval] = useState<SkillEvalResult | null>(null);
  const [cProbEval, setCProbEval] = useState<CProblemEvalResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // ── Coding agent stats from live sessions + cache monitor ──

  const codingStats = useMemo(() => {
    let totalSessions = sessions.length;
    let completedSessions = 0;
    let failedSessions = 0;
    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalLatency = 0;
    let latencySamples = 0;

    for (const session of sessions) {
      const ss = sessionStates[session.id];
      if (!ss) continue;
      const msgs = ss.messages || [];
      totalMessages += msgs.length;
      totalToolCalls += (ss.traceSteps || []).filter((s) => s.type === 'tool_call').length;

      if (session.status === 'completed') completedSessions++;
      if (session.status === 'error') failedSessions++;

      for (const msg of msgs) {
        if (msg.tokenUsage) {
          totalInput += msg.tokenUsage.input || 0;
          totalOutput += msg.tokenUsage.output || 0;
        }
        if (msg.executionTimeMs) {
          totalLatency += msg.executionTimeMs;
          latencySamples++;
        }
      }
    }

    const cs = cacheStats as Record<string, unknown> | null;
    return {
      totalSessions,
      completedSessions,
      failedSessions,
      totalMessages,
      totalToolCalls,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      avgLatency: latencySamples > 0 ? totalLatency / latencySamples : 0,
      cacheHitRate: cs && typeof cs.cacheHitRate === 'number' ? cs.cacheHitRate * 100 : null,
      cacheReadTokens: cs && typeof cs.cacheReadTokens === 'number' ? cs.cacheReadTokens : 0,
      estimatedSavings: cs && typeof cs.estimatedSavings === 'number' ? cs.estimatedSavings : 0,
      prefixDriftCount: cs && Array.isArray(cs.prefixDrifts) ? cs.prefixDrifts.length : 0,
    };
  }, [sessions, sessionStates, cacheStats]);

  // ── Run eval ──

  const runEval = useCallback(async () => {
    setIsRunning(true);
    try {
      const result = await invoke<{ docEval: DocumentEvalResult | null; skillEval: SkillEvalResult | null; cProbEval: CProblemEvalResult | null }>({
        type: 'eval.runDocumentEval' as never,
        payload: {},
      } as never);
      if (result) {
        if (result.docEval) setDocEval(result.docEval);
        if (result.skillEval) setSkillEval(result.skillEval);
        if (result.cProbEval) setCProbEval(result.cProbEval);
      }
    } catch (e) {
      console.error('[EvalPanel] Document eval failed:', e);
    }
    setIsRunning(false);
  }, [invoke]);

  // ── Render ──

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-accent" />
          <h2 className="text-sm font-semibold">{t('eval.title', 'Experiment Evaluation')}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5"
            onClick={runEval}
            disabled={isRunning}
          >
            {isRunning ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            {t('eval.run', 'Run Evaluation')}
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ─── 1. Coding Agent Metrics ─── */}
        <Section icon={Cpu} title={t('eval.codingAgent', 'Coding Agent')} defaultOpen>
          <MetricRow label={t('eval.sessions', 'Sessions')} value={codingStats.totalSessions} />
          <MetricRow
            label={t('eval.completed', 'Completed')}
            value={codingStats.completedSessions}
            color="text-green-600"
          />
          <MetricRow
            label={t('eval.failed', 'Failed')}
            value={codingStats.failedSessions}
            color={codingStats.failedSessions > 0 ? 'text-red-500' : undefined}
          />
          <MetricRow label={t('eval.messages', 'Messages')} value={codingStats.totalMessages} />
          <MetricRow label={t('eval.toolCalls', 'Tool Calls')} value={codingStats.totalToolCalls} />
          <MetricRow
            label={t('eval.inputTokens', 'Input Tokens')}
            value={formatTokens(codingStats.inputTokens)}
          />
          <MetricRow
            label={t('eval.outputTokens', 'Output Tokens')}
            value={formatTokens(codingStats.outputTokens)}
          />
          {codingStats.avgLatency > 0 && (
            <MetricRow
              label={t('eval.avgLatency', 'Avg Latency')}
              value={formatMs(codingStats.avgLatency)}
            />
          )}

          {/* Cache section */}
          <div className="mt-3 pt-3 border-t border-border-muted">
            <div className="text-xs font-medium text-text-muted mb-2 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" />
              {t('eval.cachePerformance', 'Cache Performance')}
            </div>
            {codingStats.cacheHitRate !== null ? (
              <>
                <MetricRow
                  label={t('eval.cacheHitRate', 'Cache Hit Rate')}
                  value={`${codingStats.cacheHitRate.toFixed(1)}%`}
                  color="text-green-600"
                />
                <div className="h-2 bg-surface-muted rounded-full overflow-hidden mt-1 mb-2">
                  <div
                    className="h-full bg-green-500 rounded-full transition-all"
                    style={{ width: `${Math.min(codingStats.cacheHitRate, 100)}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="text-xs text-text-muted italic">No cache data yet</div>
            )}
            <MetricRow
              label={t('eval.cacheReadTokens', 'Cache Read')}
              value={formatTokens(codingStats.cacheReadTokens)}
            />
            <MetricRow
              label={t('eval.estimatedSavings', 'Est. Savings')}
              value={`$${codingStats.estimatedSavings.toFixed(4)}`}
              color="text-green-600"
            />
            {codingStats.prefixDriftCount > 0 && (
              <MetricRow
                label={t('eval.prefixDrifts', 'Prefix Drifts')}
                value={codingStats.prefixDriftCount}
                color="text-warning"
              />
            )}
          </div>
        </Section>

        {/* ─── 2. RAG / Document Metrics ─── */}
        <Section icon={FileText} title={t('eval.ragDocument', 'RAG & Document')}>
          {docEval ? (
            <>
              <MetricRow
                label={t('eval.parseSuccessRate', 'Parse Success')}
                value={formatPercent(docEval.parseSuccessRate)}
                color={docEval.parseSuccessRate >= 0.9 ? 'text-green-600' : 'text-warning'}
              />
              {docEval.recallAtK.map((r, i) => (
                <MetricRow
                  key={i}
                  label={t('eval.recallAtK', { k: r.k }) || `Recall@${r.k}`}
                  value={formatPercent(r.recall)}
                />
              ))}
              <MetricRow
                label={t('eval.mrr', 'MRR')}
                value={docEval.mrr.toFixed(3)}
              />
              <MetricRow
                label={t('eval.evidenceHitRate', 'Evidence Hit')}
                value={formatPercent(docEval.evidenceHitRate)}
                color={docEval.evidenceHitRate >= 0.8 ? 'text-green-600' : 'text-warning'}
              />
              <MetricRow
                label={t('eval.qaAccuracy', 'QA Accuracy')}
                value={formatPercent(docEval.qaAccuracy)}
                color={docEval.qaAccuracy >= 0.8 ? 'text-green-600' : 'text-warning'}
              />

              {/* Table recognition */}
              <div className="mt-3 pt-3 border-t border-border-muted">
                <div className="text-xs font-medium text-text-muted mb-2 flex items-center gap-1.5">
                  <Table2 className="w-3.5 h-3.5" />
                  {t('eval.tableRecognition', 'Table Recognition')}
                </div>
                <MetricRow label={t('eval.rowAccuracy', 'Row Acc')} value={formatPercent(docEval.tableRecognition.rowAccuracy)} />
                <MetricRow label={t('eval.colAccuracy', 'Col Acc')} value={formatPercent(docEval.tableRecognition.colAccuracy)} />
                <MetricRow label={t('eval.mergeAccuracy', 'Merge Acc')} value={formatPercent(docEval.tableRecognition.mergeAccuracy)} />
                <MetricRow label={t('eval.headerAccuracy', 'Header Acc')} value={formatPercent(docEval.tableRecognition.headerAccuracy)} />
              </div>

              {/* Performance */}
              <div className="mt-3 pt-3 border-t border-border-muted">
                <div className="text-xs font-medium text-text-muted mb-2 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  {t('eval.performance', 'Performance')}
                </div>
                <MetricRow label={t('eval.avgParseTime', 'Avg Parse')} value={formatMs(docEval.performance.avgParseTime)} />
                <MetricRow label={t('eval.avgIndexTime', 'Avg Index')} value={formatMs(docEval.performance.avgIndexTime)} />
                <MetricRow label={t('eval.avgQueryLatency', 'Avg Query')} value={formatMs(docEval.performance.avgQueryLatency)} />
                <MetricRow label={t('eval.totalTokens', 'Total Tokens')} value={formatTokens(docEval.performance.totalTokens)} />
              </div>
            </>
          ) : (
            <div className="text-xs text-text-muted italic py-2">
              {t('eval.noDocData', 'Run evaluation to see document metrics')}
            </div>
          )}
        </Section>

        {/* ─── 3. Skill Metrics ─── */}
        <Section icon={BrainCircuit} title={t('eval.skills', 'Skills & Doc Generation')}>
          {skillEval ? (
            <>
              <MetricRow
                label={t('eval.triggerAccuracy', 'Trigger Accuracy')}
                value={formatPercent(skillEval.triggerAccuracy)}
                color={skillEval.triggerAccuracy >= 0.9 ? 'text-green-600' : 'text-warning'}
              />
              <MetricRow
                label={t('eval.generationSuccess', 'Generation Success')}
                value={formatPercent(skillEval.generationSuccessRate)}
                color={skillEval.generationSuccessRate >= 0.8 ? 'text-green-600' : 'text-warning'}
              />
              <MetricRow
                label={t('eval.validationPass', 'Validation Pass')}
                value={formatPercent(skillEval.validationPassRate)}
                color={skillEval.validationPassRate >= 0.9 ? 'text-green-600' : 'text-warning'}
              />
              <MetricRow
                label={t('eval.tokenSaved', 'Token Saved')}
                value={formatTokens(skillEval.tokenSaved)}
                color="text-green-600"
              />
              <div className="mt-3 pt-3 border-t border-border-muted">
                <div className="text-xs font-medium text-text-muted mb-2">
                  {t('eval.qualityScores', 'Quality Scores')}
                </div>
                <MetricRow label={t('eval.structureCompleteness', 'Structure')} value={(skillEval.qualityScores.structureCompleteness * 100).toFixed(0) + '%'} />
                <MetricRow label={t('eval.contentAccuracy', 'Content')} value={(skillEval.qualityScores.contentAccuracy * 100).toFixed(0) + '%'} />
                <MetricRow label={t('eval.formatCorrectness', 'Format')} value={(skillEval.qualityScores.formatCorrectness * 100).toFixed(0) + '%'} />
                <MetricRow label={t('eval.reproducibility', 'Reproducibility')} value={(skillEval.qualityScores.reproducibility * 100).toFixed(0) + '%'} />
              </div>
              {skillEval.failureAnalysis && (
                <div className="mt-2 p-2 bg-surface-muted rounded text-xs text-text-muted">
                  <span className="font-medium text-warning">Failures: </span>
                  {skillEval.failureAnalysis}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-text-muted italic py-2">
              {t('eval.noSkillData', 'Run evaluation to see skill metrics')}
            </div>
          )}
        </Section>

        {/* ─── 4. Math Modeling C Problem ─── */}
        <Section icon={Zap} title={t('eval.cProblem', 'Math Modeling C Problem')}>
          {cProbEval ? (
            <>
              <MetricRow
                label={t('eval.parseAccuracy', 'Parse Accuracy')}
                value={formatPercent(cProbEval.parseAccuracy)}
                color={cProbEval.parseAccuracy >= 0.8 ? 'text-green-600' : 'text-warning'}
              />
              <MetricRow
                label={t('eval.dataReadSuccess', 'Data Read')}
                value={cProbEval.dataReadSuccessRate >= 0.9 ? statusIcon(true) : statusIcon(false)}
              />
              <MetricRow
                label={t('eval.codeFirstRun', 'Code First Run')}
                value={cProbEval.codeFirstRunSuccess ? statusIcon(true) : statusIcon(false)}
              />
              <MetricRow label={t('eval.chartCount', 'Charts')} value={cProbEval.chartCount} />
              <MetricRow
                label={t('eval.chartCorrectRate', 'Chart Correct')}
                value={formatPercent(cProbEval.chartCorrectRate)}
                color={cProbEval.chartCorrectRate >= 0.8 ? 'text-green-600' : 'text-warning'}
              />
              <MetricRow
                label={t('eval.latexCompile', 'LaTeX Compile')}
                value={cProbEval.latexCompileSuccess ? statusIcon(true) : statusIcon(false)}
              />
              <MetricRow
                label={t('eval.paperStructure', 'Paper Structure')}
                value={(cProbEval.paperStructureScore * 100).toFixed(0) + '%'}
              />
              <MetricRow
                label={t('eval.reproducibilityScore', 'Reproducibility')}
                value={(cProbEval.reproducibilityScore * 100).toFixed(0) + '%'}
              />
              <MetricRow
                label={t('eval.humanRating', 'Human Rating')}
                value={(cProbEval.humanRating * 100).toFixed(0) + '%'}
                color={cProbEval.humanRating >= 0.7 ? 'text-green-600' : 'text-warning'}
              />
              {cProbEval.failureAnalysis && (
                <div className="mt-2 p-2 bg-surface-muted rounded text-xs text-text-muted">
                  <span className="font-medium text-warning">Failures: </span>
                  {cProbEval.failureAnalysis}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-text-muted italic py-2">
              {t('eval.noCProblemData', 'Run a C problem workflow to see results')}
            </div>
          )}
        </Section>

      </div>
    </div>
  );
}
