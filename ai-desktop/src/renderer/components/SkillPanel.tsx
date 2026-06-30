/**
 * SkillPanel — Skill Management & Document Generation Interface.
 *
 * Features:
 * - Browse and manage available skills
 * - Execute skills for document generation (LaTeX, Word, PPT, Data Analysis)
 * - View generation history and results
 * - Compile LaTeX and convert documents via Pandoc
 */
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import {
  Wand2,
  FileCode,
  FileText,
  Presentation,
  BarChart3,
  Loader2,
  CheckCircle2,
  XCircle,
  Play,
  Download,
  RefreshCw,
  Terminal,
  Settings2,
} from 'lucide-react';

// ── Types ──

interface SkillInfo {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  enabled?: boolean;
  triggers?: string[];
}

interface GenResult {
  skillName: string;
  content: string;
  timestamp: number;
  type: 'latex' | 'markdown' | 'code' | 'text';
}

// ── Helpers ──

const SKILL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'latex-paper': FileCode,
  'latex-report': FileCode,
  'word-report': FileText,
  'word-lab-report': FileText,
  'ppt-slides': Presentation,
  'ppt-summary': Presentation,
  'data-analysis': BarChart3,
  'cproblem': BarChart3,
};

const SKILL_LABELS: Record<string, string> = {
  'latex-paper': 'LaTeX 论文',
  'latex-report': 'LaTeX 报告',
  'word-report': 'Word 报告',
  'word-lab-report': 'Word 实验报告',
  'ppt-slides': 'PPT 汇报',
  'ppt-summary': 'PPT 总结',
  'data-analysis': '数据分析',
  'cproblem': '数学建模 C 题',
};

function skillIcon(name: string) {
  for (const [key, Icon] of Object.entries(SKILL_ICONS)) {
    if (name.includes(key) || key.includes(name.split('/').pop() || '')) {
      return <Icon className="w-4 h-4" />;
    }
  }
  return <Wand2 className="w-4 h-4" />;
}

function skillLabel(skill: SkillInfo): string {
  if (skill.displayName) return skill.displayName;
  for (const [key, label] of Object.entries(SKILL_LABELS)) {
    if (skill.name.includes(key) || skill.id.includes(key)) return label;
  }
  return skill.name;
}

// ── Main Component ──

export function SkillPanel() {
  const { t } = useTranslation();
  const { invoke, isElectron } = useIPC();

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [genHistory, setGenHistory] = useState<GenResult[]>([]);
  const [selectedGenIdx, setSelectedGenIdx] = useState<number | null>(null);

  // Skill-specific inputs
  const [inputText, setInputText] = useState('');

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogLines((p) => [...p, `[${ts}] ${msg}`]);
  }, []);

  // ── Load skills ──

  const loadSkills = useCallback(async () => {
    if (!isElectron) return;
    try {
      const result = await invoke<SkillInfo[]>({
        type: 'skill.listSkills' as never,
        payload: {} as never,
      } as never);
      if (Array.isArray(result)) setSkills(result);
    } catch (err) {
      log(`Failed to load skills: ${err}`);
    }
  }, [invoke, isElectron, log]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  // ── Generate document ──

  const handleGenerate = useCallback(async () => {
    if (!selectedSkillId || generating) return;
    setGenerating(true);
    const skill = skills.find((s) => s.id === selectedSkillId || s.name === selectedSkillId);
    const skillName = skill?.name || selectedSkillId;

    let input: Record<string, unknown> = { task: inputText || 'Generate document' };

    // Parse structured input if possible
    try {
      const parsed = JSON.parse(inputText);
      input = parsed;
    } catch { /* not JSON, use as plain text */ }

    log(`Generating with skill: ${skillName}`);
    try {
      const result = await invoke<{ content: string; skillName: string }>({
        type: 'skill.generateDocument' as never,
        payload: { skillName, input } as never,
      } as never);
      if (result?.content) {
        const resultType = skillName.includes('latex')
          ? 'latex'
          : skillName.includes('data')
            ? 'code'
            : 'markdown';
        const genResult: GenResult = {
          skillName,
          content: result.content,
          timestamp: Date.now(),
          type: resultType as GenResult['type'],
        };
        setGenHistory((p) => [genResult, ...p]);
        setSelectedGenIdx(0);
        log(`Generated ${result.content.length} chars`);
      }
    } catch (err) {
      log(`Generation failed: ${err}`);
    } finally {
      setGenerating(false);
    }
  }, [selectedSkillId, generating, inputText, skills, invoke, log]);

  // ── Compile LaTeX ──

  const handleCompileLatex = useCallback(async (tex: string) => {
    log('Compiling LaTeX...');
    try {
      const result = await invoke<{ output: string; pdfPath: string | null }>({
        type: 'skill.runLatex' as never,
        payload: { tex } as never,
      } as never);
      if (result?.pdfPath) {
        log(`PDF generated: ${result.pdfPath}`);
      } else {
        log(`LaTeX compile failed:\n${result?.output?.substring(0, 300) || 'Unknown error'}`);
      }
    } catch (err) {
      log(`Compile error: ${err}`);
    }
  }, [invoke, log]);

  // ── Selected skill ──

  const selectedSkill = skills.find((s) => s.id === selectedSkillId || s.name === selectedSkillId);
  const selectedGen = selectedGenIdx !== null ? genHistory[selectedGenIdx] : null;

  return (
    <div className="flex-1 flex min-h-0">
      {/* ── Left Sidebar: Skill List ── */}
      <div className="w-64 shrink-0 border-r border-border-subtle flex flex-col bg-surface-muted/50">
        <div className="p-3 border-b border-border-subtle">
          <button
            onClick={loadSkills}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-surface-hover hover:bg-surface-active text-text-secondary hover:text-text-primary transition-colors text-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('skill.refresh', 'Refresh')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {skills.length === 0 ? (
            <div className="p-6 text-center text-xs text-text-muted">
              <Settings2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
              {t('skill.noSkills', 'No skills found. Install skills to get started.')}
            </div>
          ) : (
            skills.map((skill) => {
              const isSelected = selectedSkillId === skill.id || selectedSkillId === skill.name;
              return (
                <div
                  key={skill.id || skill.name}
                  onClick={() => setSelectedSkillId(skill.id || skill.name)}
                  className={`p-3 border-b border-border-subtle cursor-pointer transition-colors hover:bg-surface-hover ${
                    isSelected ? 'bg-accent/10 border-l-2 border-l-accent' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={skill.enabled !== false ? 'text-accent' : 'text-text-muted'}>
                      {skillIcon(skill.name)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-text-primary truncate block">
                        {skillLabel(skill)}
                      </span>
                      {skill.description && (
                        <span className="text-[10px] text-text-muted truncate block">
                          {skill.description}
                        </span>
                      )}
                    </div>
                    {skill.enabled !== false ? (
                      <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                    ) : (
                      <XCircle className="w-3 h-3 text-text-muted shrink-0" />
                    )}
                  </div>
                </div>
              );
            })
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
        {!selectedSkill ? (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            <div className="text-center space-y-3">
              <Wand2 className="w-12 h-12 mx-auto opacity-20" />
              <p className="text-sm">{t('skill.selectHint', 'Select a skill from the list')}</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Skill Info Header */}
            <div className="px-4 py-3 border-b border-border-subtle">
              <div className="flex items-center gap-2">
                <span className="text-accent">{skillIcon(selectedSkill.name)}</span>
                <h3 className="text-sm font-semibold text-text-primary">
                  {skillLabel(selectedSkill)}
                </h3>
                {selectedSkill.version && (
                  <span className="text-[10px] text-text-muted">v{selectedSkill.version}</span>
                )}
              </div>
              {selectedSkill.description && (
                <p className="text-xs text-text-muted mt-1">{selectedSkill.description}</p>
              )}
            </div>

            {/* Input & Generate */}
            <div className="p-4 border-b border-border-subtle space-y-3">
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={t('skill.inputPlaceholder', 'Describe what you want to generate, or paste JSON input...')}
                rows={4}
                className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50"
              />
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent text-white hover:bg-accent-hover transition-colors text-sm font-medium disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                {t('skill.generate', 'Generate')}
              </button>
            </div>

            {/* Generation Results */}
            <div className="flex-1 overflow-y-auto p-4">
              {genHistory.length === 0 ? (
                <div className="text-center py-8 text-sm text-text-muted">
                  {t('skill.noResults', 'Generated content will appear here')}
                </div>
              ) : (
                <div className="space-y-3">
                  {/* History List */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-text-muted">{t('skill.history', 'History')}:</span>
                    {genHistory.map((item, i) => (
                      <button
                        key={i}
                        onClick={() => setSelectedGenIdx(i)}
                        className={`px-2 py-1 rounded text-xs transition-colors ${
                          selectedGenIdx === i
                            ? 'bg-accent/10 text-accent'
                            : 'bg-surface-muted text-text-muted hover:text-text-secondary'
                        }`}
                      >
                        {item.skillName} — {new Date(item.timestamp).toLocaleTimeString()}
                      </button>
                    ))}
                  </div>

                  {/* Selected Result */}
                  {selectedGen && (
                    <div className="rounded-xl border border-border-subtle overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 bg-surface-muted border-b border-border-subtle">
                        <span className="text-xs font-medium text-text-primary">
                          {selectedGen.skillName} · {selectedGen.content.length} chars
                        </span>
                        <div className="flex items-center gap-1">
                          {selectedGen.type === 'latex' && (
                            <button
                              onClick={() => handleCompileLatex(selectedGen.content)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-surface-hover text-text-secondary hover:text-accent transition-colors"
                            >
                              <Terminal className="w-3 h-3" />
                              {t('skill.compileLatex', 'Compile')}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              const blob = new Blob([selectedGen.content], { type: 'text/plain' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `output.${selectedGen.type === 'latex' ? 'tex' : selectedGen.type === 'markdown' ? 'md' : 'txt'}`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-surface-hover text-text-secondary hover:text-accent transition-colors"
                          >
                            <Download className="w-3 h-3" />
                            {t('skill.download', 'Download')}
                          </button>
                        </div>
                      </div>
                      <div className="p-4 overflow-auto max-h-[60vh]">
                        <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">
                          {selectedGen.content}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
