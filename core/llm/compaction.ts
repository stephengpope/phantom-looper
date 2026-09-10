// Long assistant chats compact. Past a configurable message limit, the
// conversation so far is summarized IN THE BACKGROUND into one context
// message, which then leads the history:
//
//   1. a turn ends with the history at the limit → kick() snapshots the
//      length and starts one generateText summarizing that prefix;
//   2. turns never wait — they keep running against the OLD history while
//      the summary is written (the cached prefix stays warm, so the turns
//      in between cost nothing extra);
//   3. the summary lands → history.splice swaps the summarized prefix for
//      the one summary message. Whatever turns appended while it ran sits
//      right behind it, verbatim, there for the next turn. The history only
//      ever grows by appending, so the snapshot length is exactly what the
//      summary replaces — no lock, no merge;
//   4. a failed summary changes nothing: the history stays whole and the
//      next turn's kick tries again.
//
// One compactor per conversation (the cli's Assistant, the server's Telegram
// assistant). The caller kicks it after every turn and learns about the swap
// through onCompacted — that is where the transcript rolls to a fresh file
// (the summary opens it, the carried-over messages behind it; the old file
// stays as the archive) and where the user is told.
import { generateText, type ModelMessage } from 'ai';
import { languageModel, withCacheBreakpoints, type ModelConfig } from './createAgent.js';

/** The fallback when the setting is unset or unreadable. */
export const DEFAULT_HISTORY_LIMIT = 100;

/** The first line of the summary message — a comment in the conversation,
 *  visible for what it is to the model and in the transcript. */
export const SUMMARY_HEAD = '--- summary of our conversation ---';

export function isSummaryMessage(m: ModelMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEAD);
}

/** The ask, appended after the conversation being summarized. */
export const SUMMARY_PROMPT = 'Summarize this conversation so far into compact context for continuing it.';

export interface Compactor {
  /** After a turn: start a background compaction when the history has reached
   *  the limit. No-op while one runs or under the limit. */
  kick(history: ModelMessage[]): void;
  readonly running: boolean;
}

export function createCompactor(opts: {
  /** The Assistant's resolved model, read AT KICK so a /model change is
   *  followed. May throw (no model configured): the kick fails quietly. */
  model: () => ModelConfig;
  /** The message limit, read at kick so a settings change is followed. */
  limit: () => number;
  /** The swap landed: `dropped` messages became the summary (history's new
   *  length is what it was minus `dropped` plus one). Roll the transcript
   *  and tell the user here. */
  onCompacted?: (dropped: number) => void;
  /** The summary call failed — the history is untouched, the next kick
   *  retries. */
  onFailed?: (err: Error) => void;
}): Compactor {
  let running = false;
  return {
    get running() { return running; },
    kick(history) {
      const limit = opts.limit();
      if (running || !Number.isFinite(limit) || limit <= 0 || history.length < limit) return;
      running = true;
      const at = history.length;
      const snapshot = history.slice(0, at);
      void (async () => {
        try {
          const { text } = await generateText({
            model: languageModel(opts.model()),
            maxRetries: 0,   // transport retries live in languageModel's fetch wrapper
            // The marks let the call read the conversation back from the
            // provider's cache — the last turn already wrote it there.
            messages: withCacheBreakpoints([...snapshot, { role: 'user', content: SUMMARY_PROMPT }]),
          });
          const summary = text.trim();
          if (!summary) throw new Error('the model answered an empty summary');
          history.splice(0, at, { role: 'user', content: `${SUMMARY_HEAD}\n${summary}` } as ModelMessage);
          opts.onCompacted?.(at);
        } catch (e) {
          opts.onFailed?.(e as Error);
        } finally {
          running = false;
        }
      })();
    },
  };
}
