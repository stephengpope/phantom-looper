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
import { titleRequest, type TitleContext } from '../core/llm/prompts/helpers/wiring.js';
import { parseTranscript } from '../core/llm/transcript.js';
import { resolveMany, resolveCredential, credentialForProvider } from './settings.js';
import { loops, sessions } from './db/schema.js';
import type { Db } from './db/client.js';
import { logger, errStr } from './log.js';

const log = logger('session-title');

const FIRST_USER_MESSAGES = 5;
const LAST_USER_MESSAGES = 20;
const USER_MESSAGE_CAP = 1000;
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
  return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
};

const messageText = (content: unknown): string => {
  const body = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map(partText).join('\n') : '';
  return clip(body.trim().replace(/\s+/g, ' '), USER_MESSAGE_CAP);
};

/** The title's whole view of a conversation: the user's first 5 messages and,
 *  once there are more than 25, the last 20, with the skipped middle counted.
 *  Assistant and tool messages never enter the title call. */
export function userMessagesContext(userMessages: string[]): TitleContext {
  const messages = userMessages.map((m) => m.trim().replace(/\s+/g, ' '))
    .map((m) => clip(m, USER_MESSAGE_CAP)).filter(Boolean);
  if (!messages.length) return { contextNote: '', userMessages: '' };

  const first = messages.slice(0, FIRST_USER_MESSAGES);
  const lastStart = messages.length > FIRST_USER_MESSAGES + LAST_USER_MESSAGES
    ? messages.length - LAST_USER_MESSAGES
    : first.length;
  const last = messages.slice(lastStart);
  const omitted = messages.length - first.length - last.length;
  const contextNote = omitted
    ? `This excerpt contains the first ${FIRST_USER_MESSAGES} user messages and the last ${LAST_USER_MESSAGES} user messages. ${omitted} middle messages are omitted.`
    : 'These are all user messages, oldest to newest.';

  const lines = ['FIRST USER MESSAGES',
    ...first.map((m, i) => `${i + 1}. ${m}`)];
  if (omitted) lines.push('', `MIDDLE USER MESSAGES OMITTED: ${omitted}`);
  if (last.length) lines.push('', 'LAST USER MESSAGES',
    ...last.map((m, i) => `${lastStart + i + 1}. ${m}`));
  return { contextNote, userMessages: lines.join('\n') };
}

/** The user messages in a saved transcript, selected for the title call. */
export function titleContext(jsonl: string): TitleContext {
  const { messages } = parseTranscript(jsonl);
  return userMessagesContext(messages.filter((m) => m.role === 'user')
    .map((m) => messageText(m.content)));
}

/** The first user message, before a transcript exists. */
export function firstMessageContext(message: string): TitleContext {
  return userMessagesContext([message]);
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
  } catch (e) {
    // No guessing a different model: an unbuildable assistant config means
    // no auto-title, said once in the log.
    log.warn({ err: (e as Error).message }, 'assistant model config cannot build — sessions are not auto-titled');
    return null;
  }
  if (!isProvider(c.provider) || !c.model) return null;
  const apiKey = await resolveCredential(db, encryptionKey, credentialForProvider(c.provider));
  // A missing key is languageModel's problem, not ours: the SDK fails fast
  // and locally, and the tries below swallow it — commitMessage's "no key"
  // case exactly.
  return { provider: c.provider, model: c.model, baseUrl: c.baseUrl ?? undefined, apiKey };
}

/** Write the session's name from the selected user messages. Never throws.
 *  `modelFetch` is the test seam (createAgent's own), threaded from AppCtx
 *  like the turn route's. */
export async function nameSession(
  db: Db, encryptionKey: Buffer, sessionId: string, context: TitleContext, modelFetch?: typeof fetch,
): Promise<void> {
  try {
    // A card's coding session already carries the customer's own objective:
    // the card title. It stays the session title until a person clears it.
    const cardSeat = await db.select({ id: loops.id }).from(loops)
      .where(eq(loops.codingSessionId, sessionId)).limit(1);
    if (cardSeat.length) {
      const named = await db.select({ name: sessions.name }).from(sessions)
        .where(eq(sessions.id, sessionId)).limit(1);
      if (named[0]?.name !== null) return;
    }

    const config = await titleConfig(db, encryptionKey);
    if (!config) return;
    config.fetch = modelFetch;
    if (!context.userMessages.trim()) return;
    const { system, prompt } = titleRequest(context);
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
