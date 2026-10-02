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
import type { ModelConfig } from '../../core/llm/createAgent.js';
import { commitMessagePrompt } from '../../core/prompts/autoPush/wiring.js';
import { PhantomHelper } from '../../core/llm/helper.js';
import { logger } from 'phantom-backend-sdk';

const log = logger('auto-push');

const TRIES = 3;
// No timeout and no retry loop HERE, on purpose: this call rides the ONE
// retry loop every model call rides (withRetry in core/llm/createAgent.ts —
// the schedule, the 180s budget, the give-up with the provider's own words,
// and each attempt reported through config.onRetry). A second leash on top
// fired mid-recovery — the standard schedule's waits alone reach 29s — and
// turned a rate limit every other call rides out into a failed sync.

/** The subject-line call: the staged diff's stat + patch in, a message out. */
class CommitMessageHelper extends PhantomHelper {
  run(stat: string, diff: string, card: string): Promise<string> {
    return this.call({ prompt: commitMessagePrompt(stat, diff, card) });
  }
}

/** The sync's commit-message writer (SyncDeps.writeCommitMessage), on the
 *  OLD path's model helper. `config` is the model that writes it — null
 *  throws, the sync fails with that reason: no file-name fallback anywhere.
 *  Up to TRIES answers that are empty or oversized; a refusal or a transport
 *  failure withRetry already gave up on is thrown as is — one retry loop,
 *  never stacked. */
export async function writeCommitMessage(
  config: ModelConfig | null, input: { stat: string; diff: string; card: string; sessionId: string },
): Promise<string> {
  if (!config) {
    throw new Error('no model configured to write the commit message — set one on /settings (phantom-cli), or PATCH /settings {coding_provider, coding_model}');
  }
  const helper = new CommitMessageHelper(config, input.sessionId);
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const message = (await helper.run(input.stat, input.diff, input.card)).trim();
    if (message && message.length <= 2000) return message;
    log.warn({ attempt }, 'commit message attempt answered nonsense — trying again');
  }
  throw new Error(`the model could not produce a usable commit message (${TRIES} empty or oversized answers)`);
}
