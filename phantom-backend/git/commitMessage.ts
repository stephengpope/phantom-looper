// The sync's commit message: a model writes it from the session's WHOLE
// staged diff (everything since the merge-base) plus the card. There is NO
// fallback — base history only ever gets a real message. A model that cannot
// answer (no credits, provider down, nothing configured) throws, the sync
// fails with the provider's own words BEFORE anything is rewritten, and the
// person fixes the cause — a silent file-name message just hid the failure
// and guaranteed it repeated.
//
// The model is the ASSISTANT's (settings assistant_provider/assistant_model,
// cascading to the coding agent's) — the small-fast slot. Writing one subject
// line from a diff is not work for the model doing the engineering.
//
// The card rides along because a diff says what changed and never why. It is
// the same intent the coding agent had; this call is the only place the sync
// spends a model when nothing conflicts.
import { generateText } from 'ai';
import { languageModel, type ModelConfig } from '../../core/llm/createAgent.js';
import { commitMessagePrompt } from '../../core/llm/prompts/autoPush/wiring.js';
import { git } from './git.js';
import { logger } from '../log.js';

const log = logger('auto-push');

const MAX_DIFF_BYTES = 60_000;
const TRIES = 3;
/** The whole call's leash — transport retries included. A subject line is
 *  worth seconds; longer means the provider is in trouble and the sync
 *  should say so, not wait. */
const LEASH_MS = 30_000;

/** A subject line from the STAGED diff against `base` (the merge-base — the
 *  caller has staged everything but rewritten nothing). Throws when no real
 *  message can be produced: the sync's answer is to fail, not to guess. */
export async function commitMessageFor(
  dir: string, config: ModelConfig | null, card = '', base?: string,
): Promise<string> {
  if (!config) {
    throw new Error('no model configured to write the commit message — set one on /model (phantom-cli), or PATCH /settings {provider, model}');
  }
  const range = base ? [base] : [];
  const { stdout: stat } = await git(dir, ['diff', '--cached', '--stat', ...range]);
  const { stdout: patch } = await git(dir, ['diff', '--cached', ...range]);
  const diff = patch.length > MAX_DIFF_BYTES ? `${patch.slice(0, MAX_DIFF_BYTES)}\n… (truncated)` : patch;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const leash = AbortSignal.timeout(LEASH_MS);
    try {
      const { text } = await generateText({
        model: languageModel(config),
        maxRetries: 0, // transport retries live in languageModel's fetch wrapper
        prompt: commitMessagePrompt(stat, diff, card),
        abortSignal: leash,
      });
      const msg = text.trim();
      if (msg && msg.length <= 2000) return msg;
      log.warn({ dir, attempt }, 'commit message attempt answered nonsense — trying again');
    } catch (e) {
      // The leash, a refusal, a transport failure: all permanent for this
      // run, all reported with the provider's own words. Never retried here.
      if (leash.aborted) {
        throw new Error(`the model did not answer within ${LEASH_MS / 1000}s — it may be overloaded or unreachable`);
      }
      throw e;
    }
  }
  throw new Error(`the model could not produce a usable commit message (${TRIES} empty or oversized answers)`);
}
