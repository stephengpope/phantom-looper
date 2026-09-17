// The Assistant's conversation state — history, transcript, compaction, session
// row. Extracted from engine.ts so the 8 fields that must move together live
// behind one object boundary instead of as loose private fields on a 1000-line
// class. The engine holds one instance and calls methods on it; commands.ts
// reaches `runCompaction()` through it.

import path from 'node:path';
import type { ModelMessage } from 'ai';
import type { Sessions } from '../sessions.js';
import { helperCall } from '../../core/llm/helperCall.js';
import { agentModelConfig } from '../../core/llm/agentConfig.js';
import { loadTranscriptFile, newestTranscriptFile, Transcript, transcriptStamp } from '../../core/llm/transcript.js';
import { compact, shouldCompact, getStrategy, CompactionLock, resolveContextWindow, resolveCompactSetting } from '../../core/llm/compaction.js';
import { contextWindowFor } from '../models.js';
import type { TelegramClient } from './client.js';
import { logger } from '../log.js';

const log = logger('telegram');

export interface AssistantConversationDeps {
  /** The data root — the transcript dir lives under `<root>/assistant/`. */
  dataRoot: string;
  sessions: Sessions;
}

/** Who to notify about compaction events — set before each turn. */
export interface AssistantChat { client: TelegramClient; dm: number }

export class AssistantConversation {
  /** The in-memory conversation. */
  readonly history: ModelMessage[] = [];
  private transcript: Transcript | null = null;
  private loaded = false;
  /** The assistant's session row — what its calls are billed to. */
  sessionId: string | null = null;
  private compactionLock = new CompactionLock();

  /** Set by the engine before each turn so compaction can read the model config
   *  and send the notice to the right chat. */
  values: Record<string, unknown> = {};
  chat: AssistantChat | null = null;

  constructor(private deps: AssistantConversationDeps) {}

  // ── transcript ───────────────────────────────────────────────────────────

  private dir(): string {
    return path.join(this.deps.dataRoot, 'assistant');
  }

  /** The live transcript file, created on first write. */
  getTranscript(): Transcript {
    if (!this.transcript) {
      this.transcript = new Transcript(path.join(this.dir(), `${transcriptStamp()}.jsonl`));
    }
    return this.transcript;
  }

  /** Resume the conversation from the newest transcript — once per boot. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = newestTranscriptFile(this.dir());
    if (!file) return;
    const loaded = loadTranscriptFile(file);
    if (!loaded.messages.length) return;
    this.history.push(...loaded.messages);
    this.transcript = new Transcript(file);
  }

  // ── session row ──────────────────────────────────────────────────────────

  /** The assistant's session row, pointed at what the user is looking at —
   *  created the first time, re-pointed (workspace + folder) every turn
   *  after, since the active session moves between turns. Called BEFORE the
   *  turn's agent is built, so the model already knows what to bill. */
  async ensureSession(workspaceId: string | null, activeSessionId?: string | null): Promise<string> {
    if (!workspaceId) throw new Error('no active workspace — /workspaces to pick one');
    if (this.sessionId) {
      await this.deps.sessions.follow(this.sessionId, workspaceId, activeSessionId);
      return this.sessionId;
    }
    const row = await this.deps.sessions.createAssistant(workspaceId, activeSessionId);
    this.sessionId = row.id;
    return row.id;
  }

  // ── compaction ───────────────────────────────────────────────────────────

  /** Kick compaction if the last turn's input tokens crossed the threshold.
   *  Fire-and-forget — the next turn proceeds on the current history. */
  kickCompaction(inputTokens: number): void {
    if (this.compactionLock.active) return;
    const pct = Number(resolveCompactSetting(this.values, 'assistant', 'threshold_pct', 0));
    if (pct <= 0) return;

    const contextWindow = resolveContextWindow(
      this.values, 'assistant', contextWindowFor, agentModelConfig,
      (msg) => log.warn(msg));
    if (!contextWindow) return;
    if (!shouldCompact(inputTokens, contextWindow, pct)) return;

    void this.runCompaction().catch((err) => {
      log.warn({ err: (err as Error).message }, 'assistant compaction failed — will retry after a later turn');
      if (this.chat) {
        void this.chat.client.sendMessage(this.chat.dm,
          `⚠️ Auto-compaction failed: ${(err as Error).message}`).catch(() => {});
      }
    });
  }

  /** Run compaction. Used by auto-trigger and the manual /compact command.
   *  Returns false when there is nothing to compact (short conversation or
   *  no turn has run yet). */
  async runCompaction(): Promise<boolean> {
    // No turn has run yet — values is empty, model config would throw.
    if (!Object.keys(this.values).length) return false;
    if (!this.history.length) return false;

    const strategyName = String(resolveCompactSetting(this.values, 'assistant', 'strategy', 'fast'));
    const summarizePct = Number(resolveCompactSetting(this.values, 'assistant', 'summarize_pct', 75));
    const maxTokens = resolveCompactSetting<number | null>(this.values, 'assistant', 'max_tokens', null);
    const maxTokensOpt = maxTokens != null ? Number(maxTokens) : undefined;

    const model = agentModelConfig(this.values, 'supervisor');

    const result = await compact(this.compactionLock, {
      history: this.history,
      strategy: getStrategy(strategyName),
      summarizePct,
      call: async (system, prompt) => {
        const r = await helperCall({
          config: model, usage: { kind: 'compaction', sessionId: this.sessionId },
          system, prompt, ...(maxTokensOpt ? { maxTokens: maxTokensOpt } : {}),
        });
        return r.text;
      },
    });

    if (!result) return false;

    // Rewrite the transcript with the compacted history.
    if (this.transcript) {
      this.transcript = null;
      this.getTranscript().appendAll([...this.history]);
    }
    if (this.chat) {
      void this.chat.client.sendMessage(this.chat.dm,
        '🧠 Chat compacted — older messages are summarized.').catch(() => {});
    }
    log.info({ summaryLen: result.summary.length, historyLen: this.history.length }, 'assistant compacted');
    return true;
  }
}
