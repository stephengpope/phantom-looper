// The Assistant's conversation state — history, transcript, compaction, session
// row. Extracted from engine.ts so the 8 fields that must move together live
// behind one object boundary instead of as loose private fields on a 1000-line
// class. The engine holds one instance and calls methods on it; commands.ts
// reaches `runCompaction()` through it.

import path from 'node:path';
import type { ModelMessage } from 'ai';
import type { Sessions } from '../sessions.js';
import type { SessionRow } from '../db/schema.js';
import { loadTranscriptFile, newestTranscriptFile, Transcript, transcriptStamp } from '../../core/llm/transcript.js';
import { compact, compactionDue, compactionOpts, CompactionLock, type CompactionConfig } from '../../core/llm/compaction.js';
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

  /** Set by the engine before each turn: the assistant's compaction config
   *  (Settings.agentConfig('assistant').compaction) and the chat to notify.
   *  Null before any turn has run. */
  compaction: CompactionConfig | null = null;
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

  /** Resume the conversation from the newest transcript — once per boot.
   *  A transcript written by a previous build may have the user message
   *  after the assistant's response (the write-order bug fixed in
   *  assistant.ts).  If the first message is not a user message the
   *  conversation is misordered and the model will reject it, so discard
   *  the stale history and start a fresh file. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = newestTranscriptFile(this.dir());
    if (!file) return;
    const loaded = loadTranscriptFile(file);
    if (!loaded.messages.length) return;
    if (loaded.messages[0].role !== 'user') {
      log.warn('assistant transcript starts with %s, not user — discarding stale history', loaded.messages[0].role);
      return; // leave this.transcript null so the next turn opens a fresh file
    }
    this.history.push(...loaded.messages);
    this.transcript = new Transcript(file);
  }

  // ── session row ──────────────────────────────────────────────────────────

  /** The assistant's session row, pointed at what the user is looking at —
   *  created the first time, re-pointed (workspace + folder) every turn
   *  after, since the active session moves between turns. Called BEFORE the
   *  turn's agent is built: the turn runs on the row's model, its tools open
   *  the row's folder, and every call is billed to it. */
  async ensureSession(workspaceId: string | null, activeSessionId?: string | null): Promise<SessionRow> {
    if (!workspaceId) throw new Error('no active workspace — /workspaces to pick one');
    if (this.sessionId) {
      await this.deps.sessions.follow(this.sessionId, workspaceId, activeSessionId);
      const row = await this.deps.sessions.get(this.sessionId);
      if (row) return row;
      this.sessionId = null; // purged underneath us — make a new one
    }
    const row = await this.deps.sessions.createAssistant(workspaceId, activeSessionId);
    this.sessionId = row.id;
    return row;
  }

  // ── compaction ───────────────────────────────────────────────────────────

  /** Kick compaction if the last turn's input tokens crossed the threshold.
   *  Fire-and-forget — the next turn proceeds on the current history. */
  kickCompaction(inputTokens: number): void {
    if (this.compactionLock.active) return;
    if (!this.compaction || !compactionDue(this.compaction, inputTokens)) return;

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
    // No turn has run yet — no config, nothing to compact.
    if (!this.compaction || !this.history.length) return false;

    const result = await compact(this.compactionLock, compactionOpts(this.compaction, this.history, this.sessionId));

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
