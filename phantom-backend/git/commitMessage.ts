// The sync's commit-message writer (SyncDeps.writeCommitMessage): a subject
// line from the staged diff, written by the ASSISTANT's model — the
// small-fast slot; writing one line from a diff is not work for the model
// doing the engineering. A type that cannot build THROWS and the sync fails
// with that reason: there is no file-name fallback anywhere. Up to TRIES
// answers that are empty or oversized; a refusal or a transport failure the
// retry budget already gave up on is thrown as is — one retry loop, never
// stacked.
import { commitMessagePrompt } from '../../phantom-looper/prompts/autoPush/wiring.js';
import { oneShot, type OneShotDeps } from '../oneShot.js';
import { logger } from '@phantom-agent-sdk/backend';

const log = logger('auto-push');
const TRIES = 3;

export async function writeCommitMessage(
  deps: OneShotDeps, input: { stat: string; diff: string; card: string; sessionId: string }, report: (note: string) => void,
): Promise<string> {
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const message = (await oneShot(deps, 'assistant', { type: 'commit_message', sessionId: input.sessionId },
      { prompt: commitMessagePrompt(input.stat, input.diff, input.card) }, { report })).trim();
    if (message && message.length <= 2000) return message;
    log.warn({ attempt }, 'commit message attempt answered nonsense — trying again');
  }
  throw new Error(`the model could not produce a usable commit message (${TRIES} empty or oversized answers)`);
}
