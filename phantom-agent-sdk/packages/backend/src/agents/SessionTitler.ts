// SessionTitler — names a session from its user messages, on a cadence: the
// first message, then every 10th turn until a person names it (/rename
// turns the titler off for that session). Best effort, fire-and-forget,
// never in a save path; a failure leaves the old name standing.
//
// Selecting the messages, the cadence and writing the name back are here.
// Turning the selection into a title is a model call — `writeTitle`, which
// the app supplies until the backend writes titles on the client SDK's own
// billed model.
import { parseLines, conversationFrom } from '@phantom-agent-sdk/client/transcript';
import type { Sessions } from '../storage/Sessions.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('titler');

const FIRST_USER_MESSAGES = 5;
const LAST_USER_MESSAGES = 20;
const USER_MESSAGE_CAP = 500;
const MAX_TITLE = 80;

/** What the title call sees: the user's first 5 messages and, once there
 *  are more than 25, the last 20, with the skipped middle counted. */
export interface TitleContext { contextNote: string; userMessages: string }
/** The model call: a title from the selected messages, or null for none. Never throws. */
export type TitleWriter = (sessionId: string, context: TitleContext) => Promise<string | null>;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const partText = (part: unknown): string => {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text ?? '');
  return '';
};
const messageText = (content: unknown): string => {
  const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map(partText).join('\n') : '';
  return clip(body.trim().replace(/\s+/g, ' '), USER_MESSAGE_CAP);
};

export function userMessagesContext(userMessages: string[]): TitleContext {
  const messages = userMessages.map((message) => message.trim().replace(/\s+/g, ' ')).map((message) => clip(message, USER_MESSAGE_CAP)).filter(Boolean);
  if (!messages.length) return { contextNote: '', userMessages: '' };
  const first = messages.slice(0, FIRST_USER_MESSAGES);
  const lastStart = messages.length > FIRST_USER_MESSAGES + LAST_USER_MESSAGES ? messages.length - LAST_USER_MESSAGES : first.length;
  const last = messages.slice(lastStart);
  const omitted = messages.length - first.length - last.length;
  const contextNote = omitted
    ? `These are the session's first ${FIRST_USER_MESSAGES} user messages and last ${LAST_USER_MESSAGES} user messages. ${omitted} middle messages are omitted.`
    : `These are all of the session's user messages, oldest to newest.`;
  const lines = ['FIRST USER MESSAGES', ...first.map((message, index) => `${index + 1}. ${message}`)];
  if (omitted) lines.push('', `MIDDLE USER MESSAGES OMITTED: ${omitted}`);
  if (last.length) lines.push('', 'LAST USER MESSAGES', ...last.map((message, index) => `${lastStart + index + 1}. ${message}`));
  return { contextNote, userMessages: lines.join('\n') };
}

/** The user messages in a record, selected for the title call. */
export function titleContext(jsonl: string): TitleContext {
  const messages = conversationFrom(parseLines(jsonl));
  return userMessagesContext(messages.filter((message) => message.role === 'user').map((message) => messageText(message.content)));
}

/** Trim, strip one layer of wrapping quotes, collapse whitespace, cap. */
export function cleanTitle(raw: string): string | null {
  let title = raw.trim().replace(/\s+/g, ' ');
  const quoted = title.match(/^["'“”](.*)["'“”]$/);
  if (quoted) title = quoted[1]!.trim();
  if (!title) return null;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE).trimEnd()}…` : title;
}

export class SessionTitler {
  /** The model call, set once the app has what it needs to make one (the backend's loopback). */
  constructor(private readonly sessions: Sessions, private readonly writeTitle: TitleWriter | undefined) {}

  /** Should this session be (re)named now? */
  isDue(name: string | null, turnCount: number): boolean {
    return (name === null && turnCount === 1) || turnCount % 10 === 0;
  }

  /** Name the session from its record, or from `firstMessage` before a
   *  record exists. A session on a card keeps the card's title until a
   *  person clears it. Resolves the title written, or null. Never throws. */
  async name(sessionId: string, options: { firstMessage?: string } = {}): Promise<string | null> {
    if (!this.writeTitle) return null;
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) return null;
      if (session.cardId != null && session.name !== null) return null;
      const context = options.firstMessage !== undefined
        ? userMessagesContext([options.firstMessage])
        : titleContext((await this.sessions.transcript(sessionId)) ?? '');
      if (!context.userMessages.trim()) return null;
      const raw = await this.writeTitle(sessionId, context);
      const title = raw === null ? null : cleanTitle(raw);
      if (!title) return null;
      // A /rename that landed while the call was in flight wins: the titler never writes over a manual name.
      return (await this.sessions.setAutoTitle(sessionId, title)) ? title : null;
    } catch (error) {
      log.warn({ session: sessionId, err: errStr(error) }, 'session naming skipped');
      return null;
    }
  }
}
