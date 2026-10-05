// A session ROW as GET /sessions returns it, and the three facts every reader
// derives from one: who drives it, whether a turn is live, how long ago it
// moved. The one definition, shared by the cli's /resume table and the
// Assistant's session_list on every host — a session that reads "running" on
// screen and "idle" when the Assistant is asked is one fact with two answers.

export interface SessionRow {
  id: string; projectId: string; branch: string; status: string; lastUsedAt: string;
  /** Someone holds this session right now (server-computed, no clock math). */
  locked?: boolean;
  lockedBy?: string | null;
  lockedLabel?: string | null;
  /** The last thing the user typed, from the SERVER transcript. */
  lastUserMessage?: string | null;
  /** The model-written title — what the session is building. */
  name?: string | null;
  /** The agent type the session runs: coding, supervisor, assistant. */
  agent?: string | null;
  /** Who opened it: person, looper, cron, telegram. */
  startedBy?: string | null;
  /** Who drove the last turn (the same words); null until a turn ends. */
  lastTurnBy?: string | null;
  card?: number | null;
  /** The card's board column, from the project's cards table. */
  cardStatus?: string | null;
  /** Where the checkout's work stands: not_pushed / not_merged / merged;
   *  null = never measured. */
  workState?: 'not_pushed' | 'not_merged' | 'merged' | null;
  /** The model that drives this session — the row's pin. */
  model?: string | null;
  /** The provider that model belongs to, pinned on the row alongside it. */
  provider?: string | null;
  tokensInput?: number | null; tokensOutput?: number | null;
  tokensCacheRead?: number | null; tokensCacheWrite?: number | null;
  /** /pin: at the top of /resume. */
  pinned?: boolean;
}

/** WHOSE SESSION IT IS, for a list: the supervisor's and the assistant's by
 *  type; a coding session by who drove it last — or, before any turn, who
 *  opened it: the looper's ('coding'), a cron's, or a person's ('manual').
 *  A person typing into a cron's session makes it theirs. */
export type Driver = 'supervisor' | 'coding' | 'cron' | 'assistant' | 'manual';
export function whoDrives(session: Pick<SessionRow, 'agent' | 'startedBy' | 'lastTurnBy'>): Driver {
  const by = session.lastTurnBy ?? session.startedBy;
  return session.agent === 'supervisor' ? 'supervisor'
    : session.agent === 'assistant' ? 'assistant'
    : by === 'looper' ? 'coding'
    : by === 'cron' ? 'cron'
    : 'manual';
}

/** IS A TURN LIVE IN THIS SESSION. Two ways: a turn streaming in THIS host
 *  (`busy`), or someone else holding the lock — locks are per TURN, so a hold
 *  by anyone but us IS a turn running over there. An ended session never runs. */
export function isRunning(session: SessionRow,
  opts: { busy?: (sessionId: string) => boolean; clientId?: string } = {}): boolean {
  if (session.status !== 'active') return false;
  return (opts.busy?.(session.id) ?? false) || (!!session.locked && session.lockedBy !== (opts.clientId ?? ''));
}

/** "2h" — coarse on purpose; the exact minute never matters here. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'now';
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return days < 8 ? `${days}d` : `${Math.round(days / 7)}w`;
}
