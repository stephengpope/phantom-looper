// A session ROW as GET /sessions returns it, and the three facts every reader
// derives from one: who drives it, whether a turn is live, how long ago it
// moved. The one definition, shared by the cli's /resume table and the
// Assistant's session_list on every host — a session that reads "running" on
// screen and "idle" when the Assistant is asked is one fact with two answers.

export interface SessionRow {
  id: string; workspaceId: string; branch: string; status: string; lastUsedAt: string;
  /** Someone holds this session right now (server-computed, no clock math). */
  locked?: boolean;
  lockedBy?: string | null;
  lockedLabel?: string | null;
  /** The last thing the user typed, from the SERVER transcript. */
  lastUserMessage?: string | null;
  /** The model-written title — what the session is building. */
  name?: string | null;
  /** Who drove the last turn: 'coding'/'supervisor' for the loop's seats,
   *  'cron' for a scheduled run, 'assistant', null = a person's. */
  agent?: string | null;
  card?: number | null;
  /** The card's board column, from the workspace's cards table. */
  cardStatus?: string | null;
  /** Where the checkout's work stands: not_pushed / not_merged / merged;
   *  null = never measured. */
  work?: 'not_pushed' | 'not_merged' | 'merged' | null;
  /** The model that drives this session — the row's pin. */
  model?: string | null;
  /** The provider that model belongs to, pinned on the row alongside it. */
  provider?: string | null;
  tokensInput?: number | null; tokensOutput?: number | null;
  tokensCacheRead?: number | null; tokensCacheWrite?: number | null;
  /** /pin: at the top of /resume. */
  pinned?: boolean;
}

/** WHO DRIVES THE SESSION — the one three-way. Off the row's `agent` alone,
 *  never the card: the card link is permanent, but who is driving is not — a
 *  person who types into a card's coding session takes it over, and the row
 *  says so from the next save. `coder` names the seat, not the loop. */
export type Driver = 'supervisor' | 'coder' | 'cron' | 'assistant' | 'manual';
export function whoDrives(s: Pick<SessionRow, 'agent'>): Driver {
  return s.agent === 'supervisor' ? 'supervisor'
    : s.agent === 'coding' ? 'coder'
    : s.agent === 'cron' ? 'cron'
    : s.agent === 'assistant' ? 'assistant'
    : 'manual';
}

/** IS A TURN LIVE IN THIS SESSION. Two ways: a turn streaming in THIS host
 *  (`busy`), or someone else holding the lock — locks are per TURN, so a hold
 *  by anyone but us IS a turn running over there. An ended session never runs. */
export function isRunning(s: SessionRow,
  opts: { busy?: (sessionId: string) => boolean; clientId?: string } = {}): boolean {
  if (s.status !== 'active') return false;
  return (opts.busy?.(s.id) ?? false) || (!!s.locked && s.lockedBy !== (opts.clientId ?? ''));
}

/** "2h" — coarse on purpose; the exact minute never matters here. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  const d = Math.round(h / 24);
  return d < 8 ? `${d}d` : `${Math.round(d / 7)}w`;
}
