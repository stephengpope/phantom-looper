// The auto-push commit's message: a model writes it from the staged diff, 3 tries;
// if all three fail (no key, provider down, empty answer) the changed file
// names are used instead. The model config is the Git Fixer's — no settings of
// its own.
import { generateText } from 'ai';
import { languageModel, type ModelConfig } from '../../core/llm/createAgent.js';
import { commitMessagePrompt } from '../../core/llm/prompts/gitFixer/wiring.js';
import { git } from './git.js';
import { logger, errStr } from '../log.js';

const log = logger('auto-push');

const MAX_DIFF_BYTES = 60_000;
const TRIES = 3;

/** A subject line from the STAGED diff (the caller has already run add -A).
 *  Never throws — the file-name fallback is the floor. */
export async function commitMessageFor(dir: string, config: ModelConfig | null): Promise<string> {
  const { stdout: names } = await git(dir, ['diff', '--cached', '--name-only']);
  const files = names.trim().split('\n').filter(Boolean);
  const fallback = () => {
    const list = files.slice(0, 5).join(', ');
    return files.length > 5 ? `Update ${list} (+${files.length - 5} more)` : `Update ${list || 'files'}`;
  };
  if (!config) return fallback();
  const { stdout: stat } = await git(dir, ['diff', '--cached', '--stat']);
  const { stdout: patch } = await git(dir, ['diff', '--cached']);
  const diff = patch.length > MAX_DIFF_BYTES ? `${patch.slice(0, MAX_DIFF_BYTES)}\n… (truncated)` : patch;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const { text } = await generateText({
        model: languageModel(config),
        maxRetries: 0, // transport retries live in languageModel's fetch wrapper
        prompt: commitMessagePrompt(stat, diff),
      });
      const msg = text.trim();
      if (msg && msg.length <= 2000) return msg;
    } catch (e) {
      log.warn({ dir, attempt, err: errStr(e) }, 'commit message attempt failed');
      // An HTTP failure was already retried on the full schedule inside the
      // fetch — looping it again here would stack minutes under the git
      // lock. These 3 tries are for a model that ANSWERED nonsense.
      if ((e as { statusCode?: number }).statusCode !== undefined) break;
    }
  }
  return fallback();
}
