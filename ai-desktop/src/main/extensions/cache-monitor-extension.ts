/**
 * CacheMonitorExtension — Monitors cache hit rate, prefix stability, and
 * cumulative token savings across agent sessions. Hooks into the
 * AgentRuntimeExtension lifecycle to passively collect stats without
 * modifying the agent loop.
 */
import type { AgentRuntimeExtension, AfterSessionRunContext } from './agent-runtime-extension';
import type { Message } from '../../renderer/types';
import { log } from '../utils/logger';

export interface CacheSummary {
  /** Cumulative input tokens */
  inputTokens: number;
  /** Cumulative output tokens */
  outputTokens: number;
  /** Cumulative cache read tokens (cache hits) */
  cacheReadTokens: number;
  /** Cumulative cache write tokens (cache creations) */
  cacheWriteTokens: number;
  /** Overall cache hit rate (cacheRead / input) */
  cacheHitRate: number | null;
  /** Estimated cost saved via caching (cacheRead * inputPrice) */
  estimatedSavings: number;
  /** Number of sessions monitored */
  sessionCount: number;
  /** Per-session breakdown */
  sessions: SessionCacheStats[];
  /** Prefix drift events detected */
  prefixDrifts: PrefixDriftEvent[];
}

export interface SessionCacheStats {
  sessionId: string;
  sessionTitle: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number | null;
  messageCount: number;
  toolCallCount: number;
  startedAt: number;
}

export interface PrefixDriftEvent {
  sessionId: string;
  detectedAt: number;
  previousSignature: string;
  currentSignature: string;
  /** Which part of the prefix changed */
  changedComponent: string;
}

/**
 * Computes a "runtime signature" from messages that represents the stable
 * prefix. When this signature changes, we've had a prefix drift that will
 * invalidate the prompt cache.
 */
function computeRuntimeSignature(messages: Message[]): string {
  // Use first system message + first 3 user/assistant messages as signature
  const keyMessages = messages.slice(0, 4);
  const parts: string[] = [];
  for (const msg of keyMessages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    parts.push(`${msg.role}:${content.substring(0, 200)}`);
  }
  // Simple hash: sum of char codes
  let hash = 0;
  const joined = parts.join('|');
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) - hash + joined.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

export class CacheMonitorExtension implements AgentRuntimeExtension {
  name = 'CacheMonitor';

  private cumulative: CacheSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: null,
    estimatedSavings: 0,
    sessionCount: 0,
    sessions: [],
    prefixDrifts: [],
  };

  /** Track the runtime signature of the last session for drift detection */
  private lastSignature: string | null = null;
  private lastSessionId: string | null = null;

  /** DeepSeek cache pricing: $0.14/M input tokens, cached input $0.014/M */
  private static readonly INPUT_PRICE_PER_TOKEN = 0.14 / 1_000_000;
  private static readonly CACHE_PRICE_PER_TOKEN = 0.014 / 1_000_000;

  /** Callback to push stats to renderer */
  private pushStats: (stats: CacheSummary) => void = () => {};

  setPushStats(fn: (stats: CacheSummary) => void): void {
    this.pushStats = fn;
  }

  getSummary(): CacheSummary {
    return { ...this.cumulative };
  }

  async afterSessionRun(context: AfterSessionRunContext): Promise<void> {
    const { session, messages } = context;

    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheRead = 0;
    let sessionCacheWrite = 0;
    let toolCallCount = 0;

    for (const msg of messages) {
      if (msg.tokenUsage) {
        sessionInput += msg.tokenUsage.input || 0;
        sessionOutput += msg.tokenUsage.output || 0;
        sessionCacheRead += msg.tokenUsage.cacheRead || 0;
        sessionCacheWrite += msg.tokenUsage.cacheWrite || 0;
      }
      if (msg.role === 'assistant' && Array.isArray((msg as { content?: unknown }).content)) {
        const blocks = (msg as { content: { type: string }[] }).content;
        toolCallCount += blocks.filter((b) => b.type === 'tool_use').length;
      }
    }

    // Compute runtime signature for prefix drift detection
    const currentSignature = computeRuntimeSignature(messages);

    // Detect prefix drift
    if (this.lastSignature !== null && this.lastSessionId !== null) {
      const previousSession = this.cumulative.sessions.find(
        (s) => s.sessionId === this.lastSessionId
      );
      if (previousSession && previousSession.cacheHitRate !== null && previousSession.cacheHitRate > 0.3) {
        // Previous session had good cache hit rate; check if prefix changed
        if (currentSignature !== this.lastSignature) {
          const drift: PrefixDriftEvent = {
            sessionId: session.id,
            detectedAt: Date.now(),
            previousSignature: this.lastSignature,
            currentSignature,
            changedComponent: 'system_prompt_or_early_messages',
          };
          this.cumulative.prefixDrifts.push(drift);
          log(
            `[CacheMonitor] Prefix drift detected in session ${session.id} — ` +
              `cache may be invalidated (prev=${this.lastSignature}, curr=${currentSignature})`
          );
        }
      }
    }

    this.lastSignature = currentSignature;
    this.lastSessionId = session.id;

    // Accumulate into cumulative stats
    this.cumulative.inputTokens += sessionInput;
    this.cumulative.outputTokens += sessionOutput;
    this.cumulative.cacheReadTokens += sessionCacheRead;
    this.cumulative.cacheWriteTokens += sessionCacheWrite;
    this.cumulative.sessionCount++;

    const sessionHitRate =
      sessionInput > 0 ? sessionCacheRead / sessionInput : null;

    this.cumulative.cacheHitRate =
      this.cumulative.inputTokens > 0
        ? this.cumulative.cacheReadTokens / this.cumulative.inputTokens
        : null;

    // Estimate savings: tokens that hit cache avoided full input pricing
    const fullCostPerToken = CacheMonitorExtension.INPUT_PRICE_PER_TOKEN;
    const cacheCostPerToken = CacheMonitorExtension.CACHE_PRICE_PER_TOKEN;
    const savingsPerCachedToken = fullCostPerToken - cacheCostPerToken;
    this.cumulative.estimatedSavings =
      this.cumulative.cacheReadTokens * savingsPerCachedToken;

    // Per-session stats
    const sessionStats: SessionCacheStats = {
      sessionId: session.id,
      sessionTitle: session.title || `Session ${session.id.substring(0, 8)}`,
      inputTokens: sessionInput,
      outputTokens: sessionOutput,
      cacheReadTokens: sessionCacheRead,
      cacheWriteTokens: sessionCacheWrite,
      cacheHitRate: sessionHitRate,
      messageCount: messages.length,
      toolCallCount,
      startedAt: session.createdAt || Date.now(),
    };

    // Replace or append session stats
    const existingIdx = this.cumulative.sessions.findIndex(
      (s) => s.sessionId === session.id
    );
    if (existingIdx >= 0) {
      this.cumulative.sessions[existingIdx] = sessionStats;
    } else {
      this.cumulative.sessions.push(sessionStats);
    }

    // Keep only last 50 sessions
    if (this.cumulative.sessions.length > 50) {
      this.cumulative.sessions = this.cumulative.sessions.slice(-50);
    }

    // Keep only last 20 drift events
    if (this.cumulative.prefixDrifts.length > 20) {
      this.cumulative.prefixDrifts = this.cumulative.prefixDrifts.slice(-20);
    }

    // Push to renderer
    try {
      this.pushStats(this.getSummary());
    } catch (e) {
      // renderer may not be ready
    }

    log(
      `[CacheMonitor] Session ${session.id.substring(0, 8)} — ` +
        `input=${sessionInput}, cacheRead=${sessionCacheRead}, ` +
        `hitRate=${sessionHitRate ? (sessionHitRate * 100).toFixed(1) + '%' : 'N/A'}, ` +
        `tools=${toolCallCount}`
    );
  }

  reset(): void {
    this.cumulative = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: null,
      estimatedSavings: 0,
      sessionCount: 0,
      sessions: [],
      prefixDrifts: [],
    };
    this.lastSignature = null;
    this.lastSessionId = null;
  }
}

/** Singleton */
let cacheMonitorInstance: CacheMonitorExtension | null = null;

export function getCacheMonitor(): CacheMonitorExtension {
  if (!cacheMonitorInstance) {
    cacheMonitorInstance = new CacheMonitorExtension();
  }
  return cacheMonitorInstance;
}
