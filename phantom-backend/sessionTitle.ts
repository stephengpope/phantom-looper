// The session title: a model names what the session is building — best-effort,
// fired from the session routes (fire-and-forget), never in a save path.
// Two triggers: a session's FIRST message, the moment its turn starts
// (`turnStarted` says so — no waiting for the reply), and the transcript
// save afterwards on shouldName's cadence: +1 turn per save, name at turn 1
// while still unnamed, then every 10th turn — a duplicate arrives named with its
// clock at 0 and renames on its own schedule. The prompt is its own document
// (core/llm/prompts/helpers/); the model is the Assistant's config, and
// a half-set assistant pair falls back silently to the coding agent's. Never throws — on any failure the old name (or null) stands (the
// commitMessage.ts pattern).
import { and, eq } from 'drizzle-orm';
import { generateText } from 'ai';
import { languageModel, isProvider, type ModelConfig } from '../core/llm/createAgent.js';
import { cascade } from '../core/llm/agentConfig.js';
import { titleRequest } from '../core/llm/prompts/helpers/wiring.js';
import { parseTranscript } from '../core/llm/transcript.js';
import { resolveMany, resolveCredential, credentialForProvider } from './settings.js';
import { sessions } from './db/schema.js';
import type { Db } from './db/client.js';
import { logger, errStr } from './log.js';

const log = logger('session-title');

const TAIL_MESSAGES = 20;
const TOOL_PART_CAP = 400;
const TEXT_CAP = 4000;
const MAX_TITLE = 80;
const TRIES = 3;

/** When a save's new turn count warrants a (re)name: turn 1 while unnamed,
 *  every 10th turn after — which is also what keeps a fresh duplicate (name
 *  copied, count 0) from burning a call on its first turn. */
export function shouldName(name: string | null, turnCount: number): boolean {
  return (name === null && turnCount === 1) || turnCount % 10 === 0;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const partText = (p: unknown): string => {
  const part = p as { type?: string; text?: string };
  if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  // Tool calls and results: enough to see WHAT happened, truncated hard.
  return clip(JSON.stringify(p), TOOL_PART_CAP);
};

/** The last ~20 messages as plain "role: text" blocks, tool traffic clipped. */
export function recentMessages(jsonl: string): string {
  const { messages } = parseTranscript(jsonl);
  return messages.slice(-TAIL_MESSAGES).map((m) => {
    const body = typeof m.content === 'string'
      ? m.content
      : (m.content as unknown[]).map(partText).join('\n');
    return `${m.role}: ${clip(body, m.role === 'tool' ? TOOL_PART_CAP : TEXT_CAP)}`;
  }).join('\n\n');
}

/** Trim, strip one layer of wrapping quotes, collapse whitespace, cap. */
export function cleanTitle(raw: string): string | null {
  let t = raw.trim().replace(/\s+/g, ' ');
  const quoted = t.match(/^["'“”](.*)["'“”]$/);
  if (quoted) t = quoted[1].trim();
  if (!t) return null;
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE).trimEnd()}…` : t;
}

/** The Assistant's trio cascading to the coding agent's (core rule); a bad
 *  pair falls back to the coding config outright — a title is never worth an
 *  error. null = no usable config (unknown provider, no model): skip. */
async function titleConfig(db: Db, encryptionKey: Buffer): Promise<ModelConfig | null> {
  const cfg = await resolveMany(db, ['provider', 'model', 'base_url',
    'assistant_provider', 'assistant_model', 'assistant_base_url']);
  let c: { provider: string; model: string | null; baseUrl: string | null };
  try {
    c = cascade(cfg, 'assistant');
  } catch {
    c = { provider: cfg.provider == null ? '' : String(cfg.provider), model: cfg.model == null ? null : String(cfg.model),
      baseUrl: (cfg.base_url as string | null) ?? null };
  }
  if (!isProvider(c.provider) || !c.model) return null;
  const apiKey = await resolveCredential(db, encryptionKey, credentialForProvider(c.provider));
  // A missing key is languageModel's problem, not ours: the SDK fails fast
  // and locally, and the tries below swallow it — commitMessage's "no key"
  // case exactly.
  return { provider: c.provider, model: c.model, baseUrl: c.baseUrl ?? undefined, apiKey };
}

/** Write the session's name from the transcript it just saved. Never throws.
 *  `modelFetch` is the test seam (createAgent's own), threaded from AppCtx
 *  like the turn route's. */
/** `recent` is the conversation as "role: text" blocks — `recentMessages`
 *  off a saved transcript, or the one user line a turn just started with. */
export async function nameSession(
  db: Db, encryptionKey: Buffer, sessionId: string, recent: string, modelFetch?: typeof fetch,
): Promise<void> {
  try {
    const config = await titleConfig(db, encryptionKey);
    if (!config) return;
    config.fetch = modelFetch;
    if (!recent.trim()) return;
    const { system, prompt } = titleRequest(recent);
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try {
        const { text } = await generateText({
          model: languageModel(config),
          maxRetries: 0, // transport retries live in languageModel's fetch wrapper
          system, prompt,
        });
        const title = cleanTitle(text);
        if (title) {
          // A /rename that landed while this call was in flight wins: the
          // titler never writes over a manual name.
          await db.update(sessions).set({ name: title })
            .where(and(eq(sessions.id, sessionId), eq(sessions.nameManual, false)));
          return;
        }
      } catch (e) {
        log.warn({ session: sessionId, attempt, err: errStr(e) }, 'session title attempt failed');
        // HTTP failures were already retried on the full schedule inside the
        // fetch; these tries are for a model that ANSWERED nonsense.
        if ((e as { statusCode?: number }).statusCode !== undefined) break;
      }
    }
  } catch (e) {
    log.warn({ session: sessionId, err: errStr(e) }, 'session naming skipped');
  }
}
