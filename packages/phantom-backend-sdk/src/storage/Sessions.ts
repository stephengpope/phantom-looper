// The session row's ONE owner. Every read and every write of the `sessions`
// table goes through the `Sessions` object below — no route, no engine, no
// job touches the table directly, and this file is the only one in the
// backend that imports it. That is what makes the row's rules real (the pin
// written once, a manual name the titler never overwrites, the lock's
// conditional UPDATE) and what gives a future list feed one place to hang.
//
// A session is a CONVERSATION. It uses one WORKSPACE (workspace_id) — the
// checkout: files, branch, container. Its agent type says which (AgentTypes):
// an `own` type's workspace is its own (same id); a `borrow` type's is
// another session's; a `none` type has none. No type is known here by name.
// The checkout's facts — files present, last touched, last pushed, git state
// — are the workspace's (Workspaces); every read here joins them in (`view`), so
// the row a caller gets carries `status`, `lastUsedAt`, `lastPushAt`,
// `work` and `branch` as before. `workspaceOf` is the ONE answer to "which
// workspace does this session use".
//
// Events: a write that changes a fact a watcher draws (name, plan mode, agent,
// the record landing) publishes it here, with the write; EVERY other write
// publishes a bare `session` record — "this row moved" — which is what the
// session LIST feed (GET /sessions/events) is built on, so no writer anywhere
// has to remember to tell the list. The workspace's writes (touch, work, push)
// publish the same way under the workspace's id (Workspaces). Lock events proper
// stay with their callers: a hold means different things to a window (its
// spinner) and to a git sync (nothing to show), so the caller says.
import { and, desc, eq, gt, ilike, inArray, isNull, isNotNull, lt, not, or, count, sql as sqlRaw, type SQL } from 'drizzle-orm';
import type { Drizzle } from './Database.js';
import type { PgColumn } from 'drizzle-orm/pg-core';
// `workspaces` and `cards` appear here for JOINs only: every session read
// carries its workspace's checkout facts, the list carries the card number and
// column, the card reads take a number. Their rows are Workspaces' and Cards'
// to write.
import { sessions, sessionColumns, workspaces, cards, logTokens, type SessionRow } from './schema.js';
import type { Settings } from './Settings.js';
import type { AgentConfig } from '../agents/AgentConfig.js';
import type { AgentTypes } from '../agents/AgentTypes.js';
import type { Projects } from './Projects.js';
import type { Workspaces } from './Workspaces.js';
import { newId } from 'phantom-client-sdk';
import { logger } from '../lib/log.js';
import { withoutUsageLines } from 'phantom-client-sdk/transcript';
import type { SystemPromptLayout, StoredSystemPrompt } from 'phantom-client-sdk/systemPrompt';
import { SystemPrompt } from '../agents/SystemPrompt.js';
import { repoDir, type Paths } from '../lib/paths.js';
import type Docker from 'dockerode';
import { GLOBAL, projectScope } from '../lib/scopes.js';
import type { SessionEvents } from '../agents/SessionEvents.js';

const log = logger('sessions');

export class SessionError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

/** A freshly created session: the commit its own checkout was cut from rides
 *  along for the response (null for a session with no checkout of its own;
 *  `branch` is then the borrowed workspace's, or null). */
export type SessionFull = SessionRow & { cutFromSha: string | null };

/** What opens a session: its type, who opened it (`person` when unsaid),
 *  the session whose workspace a `borrow` type reads, and — for an `own`
 *  type — the id to restart. */
export interface StartOptions { type: string; startedBy?: string; workspaceSessionId?: string | null; id?: string }

/** The list's preview of the last thing the user typed: a few dozen
 *  characters on screen, so this many stored — never the record. */
export const LAST_MESSAGE_CHARS = 200;

/** Who acts when a client says nothing (x-phantom-looper-actor): a person.
 *  Every automation names itself, and the app lists which of those a default
 *  listing leaves out (backgroundStarters). Recorded as a session's
 *  `started_by` (who opened it) and `last_turn_by` (who drove it last). */
export const PERSON = 'person';

/** What GET /sessions accepts — the object owns what the list IS: the
 *  filters and the count share one WHERE, so `total` is exactly the rows the
 *  pages add up to. */
export interface ListQuery {
  /** Only sessions something was typed into (a last message exists). */
  typed?: boolean;
  /** false = leave out the background sessions: the types listed
   *  `background`, and the sessions a background actor (backgroundStarters)
   *  drove last — opened and never touched, or last worked by the
   *  automation. A person's turn into one brings it back into view. Types
   *  listed `never` are never rows. */
  background?: boolean;
  /** One substring, case-insensitive, anywhere in the name, the last user
   *  message or the branch. */
  q?: string;
  /** Only this project's sessions (/resume's ←→ cycle). */
  project?: string;
  limit?: number;
  /** The cursor: the whole sort key of the last row the client saw. */
  before?: Date;
  beforeId?: string;
  beforePinned?: boolean;
}

/** A list row: the session plus its card's number and the card's column. */
export type ListedSession = SessionRow & { card: number | null; cardStatus: string | null };

// ── Pure rules — no row in hand, nothing to await ────────────────────────────

/** A session that holds only its conversation — no checkout of its own, no
 *  container, nothing on disk: it borrows another session's workspace or
 *  has none (a `borrow` or `none` type). */
export const conversationOnly = (s: SessionRow): boolean => !ownsWorkspace(s);

/** The rows that own their checkout — the SQL twin of `ownsWorkspace`. */
const ownsItsWorkspace = eq(sessions.workspaceId, sessions.id);

/** Duplicating copies a conversation into a fresh checkout — meaningless for
 *  a record that has no checkout and belongs to its card's run. */
export function assertDuplicable(s: SessionRow): void {
  if (conversationOnly(s)) {
    throw new SessionError('invalid_args',
      'a session without a checkout of its own has nothing to duplicate — duplicate the session whose workspace it reads');
  }
}

/** The copy's name: the source's behind a `DUP: ` mark, so the two rows are
 *  told apart in every list (and `/resume dup` finds every copy). One mark
 *  only — a copy of a copy is still just a copy. An unnamed source leaves
 *  the copy unnamed for the titler. */
export const DUP_PREFIX = 'DUP: ';
export function copyName(name: string | null): string | null {
  if (name === null) return null;
  return name.startsWith(DUP_PREFIX) ? name : `${DUP_PREFIX}${name}`;
}

/** THE workspace this session's tools open. Null only on a borrowing session
 *  pointed at nothing yet — then there are no files, and a caller that needs
 *  them is refused; nothing ever falls back to the session's own id. */
export function workspaceOf(s: Pick<SessionRow, 'id' | 'workspaceId'>): string {
  if (!s.workspaceId) throw new SessionError('no_workspace', `session ${s.id} has no workspace — nothing to read`);
  return s.workspaceId;
}

/** How many lines a record holds — the count `transcript_lines` keeps and
 *  every write path must set, whole-file writes included: the append route
 *  lands a write only when the writer's count equals it, and `?after=N`
 *  reads from it. */
export const lineCount = (jsonl: string): number => jsonl.split('\n').filter((l) => l.trim()).length;

/** Does the session own its files — is the workspace its own? Only an owner
 *  has files to destroy, restart, back up or sweep. */
export const ownsWorkspace = (s: Pick<SessionRow, 'id' | 'workspaceId'>): boolean => s.workspaceId === s.id;

/** Is the hold live right now — someone holds it and the clock has not run
 *  out. THE rule every `locked` on the wire and every guard reads. */
export const isHeld = (s: Pick<SessionRow, 'lockedBy' | 'lockExpiresAt'>, now = Date.now()): boolean =>
  !!s.lockedBy && !!s.lockExpiresAt && s.lockExpiresAt.getTime() > now;

/** Held right now by someone who is not `client`? An expired hold is no hold. */
export const heldByOther = (s: SessionRow, client: string): boolean =>
  isHeld(s) && s.lockedBy !== client;

/** A hold that ended by the clock alone. A holder RELEASES when its turn
 *  ends; only a holder that died mid-turn — a crashed window, a killed
 *  process — leaves its hold to expire. The row keeps who and when: that is
 *  the evidence, read here. Null while free (released) or still held. */
export function expiredHold(s: Pick<SessionRow, 'lockedBy' | 'lockedLabel' | 'lockExpiresAt'>, now = Date.now()):
{ by: string; label: string | null; at: Date } | null {
  if (!s.lockedBy || !s.lockExpiresAt || s.lockExpiresAt.getTime() > now) return null;
  return { by: s.lockedBy, label: s.lockedLabel, at: s.lockExpiresAt };
}

// ── The object ───────────────────────────────────────────────────────────────

export class Sessions {
  constructor(
    private readonly db: Drizzle,
    private readonly settings: Settings,
    private readonly agentConfig: AgentConfig,
    private readonly agentTypes: AgentTypes,
    private readonly projects: Projects,
    private readonly workspaces: Workspaces,
    private readonly deps: {
      /** The `started_by` values a default list leaves out (the app's automations). */
      backgroundStarters: readonly string[];
      /** The per-session feed; absent in tests that have no watchers. */
      events?: SessionEvents;
      /** What freezing a session's prompt reads: the checkout's skills and the
       *  image's system skills. Absent in tests: `start` then freezes no skills. */
      prompt?: { paths: Paths; docker?: Docker };
    },
  ) {}
  private get events(): SessionEvents | undefined { return this.deps.events; }

  // ── start, interrupt ─────────────────────────────────────────────────────
  // The two session acts every client performs, at the object — the routes
  // are thin over them, and the server's own engines (Telegram, card runs)
  // call them here rather than over HTTP.

  /** Create — or restart — a session AND write its system prompt: the
   *  agent's layout filled with THIS moment's facts (skills, secrets,
   *  SOUL.md, the date), sent as stored on every turn after. A restart keeps
   *  the prompt the session was born with. The row and the prompt come back
   *  together — what POST /sessions answers with.
   *
   *  What is made is the TYPE's business (AgentTypes.workspaceOf): an `own`
   *  type gets a checkout of its own; a `borrow` type gets a conversation
   *  row pointed at `workspaceSessionId`'s workspace (none = nothing to read
   *  yet); a `none` type gets a conversation row and no workspace. */
  async start(projectId: string, layout: SystemPromptLayout, opts: StartOptions): Promise<SessionFull & { system_prompt: StoredSystemPrompt }> {
    SystemPrompt.check(layout);
    const s = await this.create(projectId, opts);
    return { ...s, system_prompt: await this.writeSystemPrompt(s, layout) };
  }

  /** Assemble the agent's layout from the session's facts and freeze it on
   *  the row. The checkout the blocks read is the session's own workspace, or
   *  the one it borrows; none when there is nothing to read. */
  private async writeSystemPrompt(s: SessionRow, layout: SystemPromptLayout): Promise<StoredSystemPrompt> {
    const project = (await this.projects.get(s.projectId))!;
    const prompt = await SystemPrompt.assemble(layout, {
      projectId: s.projectId, project, settings: this.settings,
      checkout: this.deps.prompt && s.workspaceId ? repoDir(this.deps.prompt.paths, s.workspaceId) : null,
      docker: this.deps.prompt?.docker,
    });
    return this.freezeSystemPrompt(s.id, prompt.sections());
  }

  /** Stop whatever turn is running on a session: foreground commands in
   *  its container are killed (detached ones are left by design), and an
   *  `interrupt` record goes out on the feed so the client running a turn
   *  here — a cli window, the backend's own engines — stops its own.
   *  Published under `by`: the feed never echoes a client its own events.
   *  Idempotent. */
  interrupt(id: string, by: string, runtime: { foreground?: { killAll(id: string): void } }): void {
    runtime.foreground?.killAll(id);
    this.events?.publish(id, by, { event: 'interrupt' });
  }

  /** The row moved in a way no richer event names: the list re-reads. Under
   *  no client, so every listener hears it (the feed drops a client's own). */
  private changed(id: string): void { this.events?.publish(id, '', { event: 'session' }); }

  // ── the view ───────────────────────────────────────────────────────────────
  // A session read is the row plus its workspace's checkout facts. ONE select
  // shape and ONE join, used by every read below, so `status`, `lastUsedAt`,
  // `lastPushAt`, `work` and `branch` mean the same thing everywhere.

  /** The files' presence as the wire says it. No workspace = nothing to have
   *  destroyed, so active. */
  private static readonly status = sqlRaw<'active' | 'destroyed'>`case when ${workspaces.id} is null or ${workspaces.onDisk} then 'active' else 'destroyed' end`;
  /** A session with no workspace has never touched a checkout: its birth is
   *  its last activity. */
  private static readonly lastUsedAt = sqlRaw<Date>`coalesce(${workspaces.lastUsedAt}, ${sessions.createdAt})`.mapWith((v) => new Date(v));
  private static readonly view = {
    ...sessionColumns, branch: workspaces.branch, status: Sessions.status, lastUsedAt: Sessions.lastUsedAt,
    lastPushAt: workspaces.lastPushAt, workState: workspaces.workState,
  };
  /** `select view from sessions left join workspaces` — every read starts here. */
  private from() {
    return this.db.select(Sessions.view).from(sessions).leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId));
  }

  // ── the model ──────────────────────────────────────────────────────────────
  // THE RULE: a session's model is its row's provider/model/base_url, and
  // nothing else. Written when the session is born (from the settings, per
  // project; a duplicate takes its source's; a cron's run takes its cron's —
  // stampModel). While nothing has been said —
  // turn_count 0 — the row follows the settings, so /settings and a preset reach
  // a session you have not spoken to yet. The first saved turn moves the
  // count to 1 and the row never changes again. Every runner reads the row.

  /** What a session of `type` born in this project runs on right now. */
  private async birthModel(projectId: string, type: string):
  Promise<{ provider: string | null; model: string | null; baseUrl: string | null }> {
    const project = await this.projects.get(projectId);
    try {
      const m = await this.agentConfig.modelFor(type, project ? { projectId: project.id } : {});
      // A whole pin or none: a provider with no model is nothing to run on.
      return m.provider && m.model ? m : { provider: null, model: null, baseUrl: null };
    } catch { return { provider: null, model: null, baseUrl: null }; } // a half-set pair — the row stays empty
  }

  /** A setting changed: every session with nothing said yet (and no turn in
   *  flight) takes the settings' model now. The row change goes out on the
   *  session feed, so a window showing that session repaints from it. */
  async followModelSettings(): Promise<void> {
    const rows = await this.from().where(eq(sessions.turnCount, 0));
    const now = Date.now();
    for (const s of rows) {
      if (isHeld(s, now)) continue;
      const m = await this.birthModel(s.projectId, s.agent);
      if (m.provider === s.provider && m.model === s.model && m.baseUrl === s.baseUrl) continue;
      await this.db.update(sessions).set(m).where(eq(sessions.id, s.id));
      this.events?.publish(s.id, '', { event: 'session', provider: m.provider, model: m.model, base_url: m.baseUrl });
    }
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async get(id: string): Promise<SessionRow | undefined> {
    const rows = await this.from().where(eq(sessions.id, id));
    return rows[0];
  }

  /** The stored conversation (JSONL), or null when none was ever saved. The
   *  one read that names the blob on purpose. `after` = only the lines past
   *  the first N — what a client holding N lines needs to catch up. */
  async transcript(id: string, after?: number): Promise<string | null> {
    const rows = await this.db.select({ data: sessions.transcript }).from(sessions).where(eq(sessions.id, id));
    const data = rows[0]?.data ?? null;
    if (data === null || !after) return data;
    let pos = 0;
    for (let n = 0; n < after; n++) {
      const nl = data.indexOf('\n', pos);
      if (nl < 0) return '';
      pos = nl + 1;
    }
    return data.slice(pos);
  }

  /** The frozen system prompt, or null when the row has none (born before
   *  025 and never opened since). The other read that names a blob on
   *  purpose. */
  async systemPrompt(id: string): Promise<StoredSystemPrompt | null> {
    const rows = await this.db.select({ prompt: sessions.systemPrompt }).from(sessions).where(eq(sessions.id, id));
    return rows[0]?.prompt ?? null;
  }

  /** Write the prompt once: only a row with none takes it, so a restart or a
   *  re-open can never move a running session's prompt. Returns what the row
   *  holds afterwards. */
  async freezeSystemPrompt(id: string, prompt: StoredSystemPrompt): Promise<StoredSystemPrompt> {
    const rows = await this.db.update(sessions).set({ systemPrompt: prompt })
      .where(and(eq(sessions.id, id), isNull(sessions.systemPrompt)))
      .returning({ prompt: sessions.systemPrompt });
    return rows[0]?.prompt ?? (await this.systemPrompt(id))!;
  }

  /** When the record last moved — the stamp a turn compares before running. */
  async transcriptStamp(id: string): Promise<Date | null> {
    const rows = await this.db.select({ updatedAt: sessions.transcriptUpdatedAt }).from(sessions)
      .where(eq(sessions.id, id));
    return rows[0]?.updatedAt ?? null;
  }

  /** GET /sessions: pinned first, then newest activity first, destroyed rows
   *  included (status says which). Which TYPES are rows is the registry's
   *  word (`listed`); which OPENERS are background is the app's
   *  (backgroundStarters). `total` counts the same WHERE. */
  async list(q: ListQuery): Promise<{ sessions: ListedSession[]; total: number }> {
    const background = q.background !== false;
    const listedTypes = this.agentTypes.listedNames({ background });
    if (!listedTypes.length) return { sessions: [], total: 0 }; // inArray refuses an empty list
    const filters: Array<SQL | undefined> = [inArray(sessions.agent, listedTypes)];
    if (q.typed === true) filters.push(isNotNull(sessions.lastUserMessage));
    if (!background && this.deps.backgroundStarters.length) {
      filters.push(not(inArray(sqlRaw`coalesce(${sessions.lastTurnBy}, ${sessions.startedBy})`, [...this.deps.backgroundStarters])));
    }
    // ONE substring, wherever it appears — no word splitting, no ranking; the
    // list keeps its order and just gets shorter. `%` and `_` are LIKE's own
    // wildcards, so typed ones are escaped.
    const text = q.q?.trim();
    if (text) {
      const needle = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(or(ilike(sessions.name, needle), ilike(sessions.lastUserMessage, needle), ilike(workspaces.branch, needle)));
    }
    if (q.project) filters.push(eq(sessions.projectId, q.project));
    // The cursor is the whole sort key of the last row the client saw:
    // pinned first (a pinned tail means only unpinned rows follow), then
    // the (last_used_at, id) pair. id descends too: a page boundary between
    // rows sharing a timestamp must cut the same way every time or the next
    // page skips or repeats.
    const cut = q.before && !isNaN(q.before.getTime()) ? q.before : undefined;
    const cursor = cut
      ? or(
        q.beforePinned === true ? eq(sessions.pinned, false) : undefined,
        and(eq(sessions.pinned, q.beforePinned === true),
          q.beforeId
            ? or(lt(Sessions.lastUsedAt, cut), and(eq(Sessions.lastUsedAt, cut), lt(sessions.id, q.beforeId)))
            : lt(Sessions.lastUsedAt, cut)))
      : undefined;
    // Token totals: LEFT JOIN log_tokens and SUM — the one store for spend.
    // A bigint SUM comes back from pg as text; mapWith(Number) makes it the
    // number the type says it is.
    const sum = (col: PgColumn) => sqlRaw<number>`coalesce(sum(${col}), 0)`.mapWith(Number);
    let page = this.db
      .select({
        ...Sessions.view, card: cards.number, cardStatus: cards.status,
        tokensInput: sum(logTokens.tokensInput).as('tokens_input'),
        tokensOutput: sum(logTokens.tokensOutput).as('tokens_output'),
        tokensCacheRead: sum(logTokens.tokensCacheRead).as('tokens_cache_read'),
        tokensCacheWrite: sum(logTokens.tokensCacheWrite).as('tokens_cache_write'),
      })
      .from(sessions)
      .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
      .leftJoin(cards, eq(cards.id, sessions.cardId))
      .leftJoin(logTokens, eq(logTokens.sessionId, sessions.id))
      .where(and(...filters, ...(cursor ? [cursor] : [])))
      .groupBy(sessions.id, workspaces.id, cards.number, cards.status)
      .orderBy(desc(sessions.pinned), desc(Sessions.lastUsedAt), desc(sessions.id))
      .$dynamic();
    if (q.limit) page = page.limit(q.limit);
    const [rows, [{ total }]] = await Promise.all([
      page,
      // The same joins as the page: the filters reach workspaces (branch).
      this.db.select({ total: count() }).from(sessions)
        .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
        .where(and(...filters)),
    ]);
    return { sessions: rows, total };
  }

  /** Of `workspaceIds`, those where a turn is running: any session on the
   *  workspace — its owner or any session borrowing it — holds a live lock. */
  async workspacesHeld(workspaceIds: string[]): Promise<Set<string>> {
    if (!workspaceIds.length) return new Set();
    const rows = await this.db.select({ workspaceId: sessions.workspaceId }).from(sessions)
      .where(and(inArray(sessions.workspaceId, workspaceIds),
        isNotNull(sessions.lockedBy), gt(sessions.lockExpiresAt, new Date())));
    return new Set(rows.flatMap((r) => (r.workspaceId ? [r.workspaceId] : [])));
  }

  /** The sessions that own files on disk — the disk sweeps' set: each is the
   *  session whose workspace is its own and present. */
  async listOwnersOnDisk(): Promise<SessionRow[]> {
    return this.from().where(and(eq(workspaces.id, sessions.id), eq(workspaces.onDisk, true)));
  }

  // ── the card ───────────────────────────────────────────────────────────────────────
  // THE RULE: a session's card is its row's card_id. A card's coder is the
  // session that owns the card's checkout; its other sessions are read by
  // type. Nothing stores the pairing — it is read off the newest rows. The
  // card is addressed by its number here, the handle the whole app uses;
  // the row holds the key.

  /** The newest session of `type` on the card, any status. */
  async newestOnCard(projectId: string, cardNumber: number, type: string): Promise<SessionRow | undefined> {
    return this.newestOnCardWhere(projectId, cardNumber, eq(sessions.agent, type));
  }

  private async newestOnCardWhere(projectId: string, cardNumber: number, which: SQL): Promise<SessionRow | undefined> {
    const rows = await this.from()
      .innerJoin(cards, eq(cards.id, sessions.cardId))
      .where(and(eq(cards.project_id, projectId), eq(cards.number, cardNumber), which))
      .orderBy(desc(sessions.createdAt)).limit(1);
    return rows[0];
  }

  /** The card's coding session — the one that owns the card's checkout, any
   *  status: a destroyed coder is still the card's coder (the looper restarts it). */
  coderOf(projectId: string, cardNumber: number): Promise<SessionRow | undefined> {
    return this.newestOnCardWhere(projectId, cardNumber, ownsItsWorkspace);
  }

  /** Every card's coding session in a project — the newest per card, the
   *  same rule `coderOf` uses. One query for the whole board. */
  async codersByCard(projectId: string): Promise<Array<SessionRow & { card: number }>> {
    return this.db.selectDistinctOn([sessions.cardId], { ...Sessions.view, card: cards.number })
      .from(sessions)
      .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
      .innerJoin(cards, eq(cards.id, sessions.cardId))
      .where(and(eq(cards.project_id, projectId), ownsItsWorkspace))
      .orderBy(sessions.cardId, desc(sessions.createdAt));
  }

  /** Put the session on a card. The card run's write when it opens its
   *  coder; a session born of a person has none until something sets it. */
  async setCard(id: string, cardId: number): Promise<void> {
    await this.db.update(sessions).set({ cardId }).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** Sessions that went quiet: a record exists, nobody holds them NOW —
   *  released, or a hold that ran out because its holder died (the digest
   *  tells the two apart with `expiredHold`) — idle past `threshold`, and
   *  not digested since they last moved. */
  async listIdleSince(threshold: Date): Promise<SessionRow[]> {
    return this.from().where(
      and(
        or(isNull(sessions.lockedBy), isNull(sessions.lockExpiresAt), lt(sessions.lockExpiresAt, new Date())),
        lt(sessions.transcriptUpdatedAt, threshold),
        or(
          isNull(sessions.digestNotifiedAt),
          sqlRaw`${sessions.transcriptUpdatedAt} > ${sessions.digestNotifiedAt}`,
        ),
      ),
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Create a session of `type`. An `own` type is born with its own checkout
   *  (Workspaces.checkout), sharing the id; passing `id` RESTARTS one whose
   *  files were removed: the workspace remembers the branch, so the same id
   *  comes back exactly where it stopped (Workspaces.restore). `fromBranch`
   *  cuts a NEW session's branch from a source branch on origin instead of
   *  base (the duplicate route). A `borrow` type is a conversation row
   *  pointed at `workspaceSessionId`'s workspace; a `none` type, a
   *  conversation row with no workspace. */
  async create(projectId: string, opts: StartOptions & { fromBranch?: string }): Promise<SessionFull> {
    const type = opts.type;
    const shape = this.agentTypes.workspaceOf(type);
    const project = await this.projects.get(projectId);
    if (!project) throw new SessionError('not_found', `no project ${projectId}`);

    if (shape !== 'own') {
      if (opts.id || opts.fromBranch) {
        throw new SessionError('invalid_args', `a ${type} session has no checkout of its own — nothing to restart or cut a branch for`);
      }
      if (shape === 'none' && opts.workspaceSessionId) {
        throw new SessionError('invalid_args', `a ${type} session runs with no files — it cannot read another session's workspace`);
      }
      return this.createConversation(projectId, opts.type, opts.startedBy ?? PERSON,
        shape === 'borrow' ? await this.borrowedWorkspace(opts.workspaceSessionId) : null);
    }
    if (opts.workspaceSessionId) {
      throw new SessionError('invalid_args', `a ${type} session owns its checkout — it does not read another session's workspace`);
    }

    const prior = opts.id ? await this.get(opts.id) : undefined;
    if (prior && prior.projectId !== projectId) {
      throw new SessionError('project_mismatch', `session ${prior.id} belongs to another project`);
    }
    // A session that does not own its workspace has no files of its own — there
    // is nothing to restart.
    if (prior && !ownsWorkspace(prior)) {
      throw new SessionError('invalid_args', `session ${prior.id} has no checkout of its own — there are no files to restart`);
    }
    // Files still on disk: rebuilding them underneath would delete work that
    // has not been pushed yet.
    if (prior && prior.status === 'active') {
      throw new SessionError('already_active', `session ${prior.id} is still active`);
    }
    // A cut point belongs to a NEW session alone: a restart's start point is the
    // branch the workspace remembers, never a second opinion.
    if (prior && opts.fromBranch) {
      throw new SessionError('invalid_args', 'fromBranch cuts a NEW session\'s branch — a restart has its own');
    }

    if (prior) {
      const workspace = (await this.workspaces.get(prior.id))!;
      await this.workspaces.restore(workspace, project);
      log.info({ session: prior.id, branch: workspace.branch }, 'session restarted');
      const row = (await this.get(prior.id))!;
      return { ...row, branch: workspace.branch, cutFromSha: workspace.cutFromSha };
    }

    // The workspace (the checkout) and the session (the conversation) are born
    // together, sharing the id.
    const id = opts.id ?? newId();
    const workspace = await this.workspaces.checkout(project, id, { fromBranch: opts.fromBranch });
    await this.db.insert(sessions).values({ id, projectId, workspaceId: id, agent: type, startedBy: opts.startedBy ?? PERSON, ...await this.birthModel(projectId, type) });
    const row = (await this.get(id))!;
    log.info({ session: id, branch: workspace.branch }, 'session created');
    this.changed(id);
    return { ...row, branch: workspace.branch, cutFromSha: workspace.cutFromSha };
  }

  /** A conversation-only session: no checkout of its own — `workspaceId` is
   *  another session's workspace (the files it can read), or null when there
   *  is nothing to read. Answered in the shape `create` answers; there is no
   *  cut point, there being no checkout. */
  private async createConversation(projectId: string, type: string, startedBy: string, workspaceId: string | null): Promise<SessionFull> {
    const id = newId();
    await this.db.insert(sessions).values({
      id, projectId, agent: type, startedBy,
      ...(workspaceId ? { workspaceId } : {}),
      ...await this.birthModel(projectId, type),
    });
    this.changed(id);
    return { ...(await this.get(id))!, cutFromSha: null };
  }

  /** The workspace a borrowing session reads: the named session's own
   *  workspaceId — an owner's is its own, a borrower's is the one it reads —
   *  or null when no session is named. */
  private async borrowedWorkspace(workspaceSessionId: string | null | undefined): Promise<string | null> {
    if (!workspaceSessionId) return null;
    const target = await this.get(workspaceSessionId);
    if (!target) throw new SessionError('not_found', `no session ${workspaceSessionId} to read the workspace of`);
    return target.workspaceId ?? null;
  }

  /** Re-point a borrowing session at another session's files (and project):
   *  its tools read that workspace from now on. Only a `borrow` type may
   *  move; a no-op when nothing changed. */
  async repoint(id: string, projectId: string, workspaceSessionId?: string | null): Promise<void> {
    const s = await this.get(id);
    if (!s) throw new SessionError('not_found', `no session ${id}`);
    if (this.agentTypes.workspaceOf(s.agent) !== 'borrow') {
      throw new SessionError('invalid_args', `a ${s.agent} session does not borrow a workspace — nothing to re-point`);
    }
    const target = { projectId, workspaceId: await this.borrowedWorkspace(workspaceSessionId) };
    if (s.projectId === target.projectId && s.workspaceId === target.workspaceId) return;
    await this.db.update(sessions).set(target).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** What travels from a source into its freshly created copy (the duplicate
   *  route): the conversation minus its usage lines, the preview, the name
   *  (prefixed `DUP: ` so the copy is told apart from its source in every
   *  list — once, a copy of a copy does not stack), plan mode, the frozen PROMPT and the MODEL — the copy runs on what the
   *  source ran on, and can be moved with /settings or a preset until its first
   *  new message (turn_count 0, like any newborn). NO token totals — the
   *  usage lines are stripped, so the copy counts its own spend from birth. */
  async seedCopy(copy: SessionFull, src: SessionRow): Promise<void> {
    const data = await this.transcript(src.id);
    const stamp = new Date();
    await this.db.update(sessions).set({
      planMode: src.planMode,
      systemPrompt: await this.systemPrompt(src.id),
      ...(src.provider && src.model ? { provider: src.provider, model: src.model, baseUrl: src.baseUrl } : {}),
      ...(data != null ? {
        transcript: withoutUsageLines(data), transcriptLines: lineCount(withoutUsageLines(data)),
        lastUserMessage: src.lastUserMessage, name: copyName(src.name), nameManual: src.nameManual,
        transcriptUpdatedAt: stamp,
      } : {}),
    }).where(eq(sessions.id, copy.id));
    this.changed(copy.id);
  }

  /** Explicit delete honors the request even when work would be lost — that is
   *  the caller's decision to make. The automatic sweep (disk.ts) never does.
   *  Deletes the session's FILES and nothing else (Workspaces.removeFiles) — the
   *  workspace keeps the branch, so `create` with the same id restarts it where
   *  it stopped. Only a session that owns its workspace has files; a caller
   *  checks `ownsWorkspace`. */
  async destroy(session: SessionRow, opts: { force: boolean }): Promise<void> {
    if (!ownsWorkspace(session)) throw new SessionError('no_files', `session ${session.id} has no files of its own`);
    await this.workspaces.removeFiles((await this.workspaces.get(session.id))!, opts);
    log.info({ session: session.id }, 'session destroyed');
  }

  /** The row goes for good, the transcript on it. Only its pushed branch on
   *  origin survives. Files first (`destroy`). */
  async purge(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, id));
    this.changed(id);
  }

  // ── the record ─────────────────────────────────────────────────────────────

  /** Append typed lines to the record (POST /sessions/:id/transcript/append).
   *  One statement, conditional on the count: the lines land only if the
   *  record holds exactly `after` lines — else someone else wrote, and the
   *  writer is told so (transcript_conflict) to read again. A resend of a
   *  delivery that already landed (its reply was lost) is answered as such,
   *  never written twice. The record event goes out under the writer so
   *  its own window ignores the echo. */
  async appendTranscript(s: SessionRow, client: string, body: { after: number; deliveryId: string; lines: unknown[] }):
  Promise<{ lines: number; applied: boolean; stamp: Date }> {
    const text = body.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const stamp = new Date();
    const rows = await this.db.update(sessions)
      .set({
        transcript: sqlRaw`coalesce(${sessions.transcript}, '') || ${text}`,
        transcriptLines: sqlRaw`${sessions.transcriptLines} + ${body.lines.length}`,
        transcriptDelivery: body.deliveryId, transcriptUpdatedAt: stamp,
      })
      .where(and(eq(sessions.id, s.id), eq(sessions.transcriptLines, body.after)))
      .returning({ lines: sessions.transcriptLines });
    if (!rows.length) {
      const [cur] = await this.db.select({ lines: sessions.transcriptLines, delivery: sessions.transcriptDelivery,
        updatedAt: sessions.transcriptUpdatedAt }).from(sessions).where(eq(sessions.id, s.id));
      if (cur?.delivery === body.deliveryId) return { lines: cur.lines, applied: false, stamp: cur.updatedAt ?? stamp };
      throw new SessionError('transcript_conflict',
        `transcript has ${cur?.lines ?? 0} lines, the append said ${body.after} — another writer moved it; read it again`);
    }
    if (s.workspaceId) await this.workspaces.touch(s.workspaceId);
    this.events?.publish(s.id, client, { event: 'transcript', updated_at: stamp.toISOString(), by: client });
    return { lines: rows[0].lines, applied: true, stamp };
  }

  /** A turn began on the session with `message` — the moment the list's
   *  preview can move (the save at turn end used to be the first chance) and,
   *  on a session's FIRST message, the moment to name it. Says whether it is
   *  that first message: unnamed, never a turn saved, not a loop seat (a loop
   *  session's first message is the card run's fixed kickoff text, which would
   *  name every card's session after the kickoff; those are named off the
   *  save, where the reply is in). Manual names are never in play here — a
   *  renamed session is never unnamed. */
  async turnStarted(id: string, message: string): Promise<{ firstMessage: boolean }> {
    const rows = await this.db.update(sessions)
      .set({ lastUserMessage: message.slice(0, LAST_MESSAGE_CHARS) })
      .where(eq(sessions.id, id))
      .returning({ name: sessions.name, turnCount: sessions.turnCount, startedBy: sessions.startedBy });
    const r = rows[0];
    this.changed(id);
    return { firstMessage: !!r && r.name === null && r.turnCount === 0 && r.startedBy === PERSON };
  }

  /** The record's line count when a turn started, per session — so the
   *  turn's end can tell whether the turn wrote anything. In memory: a turn
   *  lives inside one server process, and an entry missing at the end (a
   *  restart mid-turn, a writer that never called turn-start) counts the turn
   *  as before. */
  readonly #linesAtTurnStart = new Map<string, number>();

  /** turn-start took the hold and wrote the queued messages: remember where
   *  the record stands now. */
  rememberLinesAtTurnStart(id: string, lines: number): void { this.#linesAtTurnStart.set(id, lines); }

  /** A turn ended on a session, whoever ran it: record who drove it
   *  (`actor`), bump the turn count — only when the turn wrote to the
   *  record, because leaving 0 is what freezes the row's model and a turn
   *  that said nothing (stopped before the first word, failed to start) must
   *  not freeze it — and touch its checkout. Tokens are not here — every
   *  model call records its own row in log_tokens. Returns what the naming
   *  decision needs. */
  async turnEnded(s: SessionRow, actor: string): Promise<{
    name: string | null; turnCount: number; nameManual: boolean;
  }> {
    const linesAtStart = this.#linesAtTurnStart.get(s.id);
    this.#linesAtTurnStart.delete(s.id);
    const wrote = linesAtStart === undefined || s.transcriptLines !== linesAtStart;
    const [saved] = await this.db.update(sessions)
      .set({ lastTurnBy: actor, ...(wrote ? { turnCount: sqlRaw`${sessions.turnCount} + 1` } : {}) })
      .where(eq(sessions.id, s.id))
      .returning({ name: sessions.name, turnCount: sessions.turnCount, nameManual: sessions.nameManual });
    if (s.workspaceId) await this.workspaces.touch(s.workspaceId);
    this.changed(s.id);
    return { name: saved.name, turnCount: saved.turnCount, nameManual: saved.nameManual };
  }

  // ── facts a person or a job sets ───────────────────────────────────────────

  /** A name by hand. null clears it and hands the session back to the
   *  titler; a set name turns the titler off for good. `by` is the client
   *  renaming, so its own window ignores the echo. */
  async rename(id: string, name: string | null, by: string): Promise<void> {
    await this.db.update(sessions).set({ name, nameManual: name !== null }).where(eq(sessions.id, id));
    this.events?.publish(id, by, { event: 'session', name });
  }

  /** The titler's name. A /rename that landed while the title was being
   *  written wins: the titler never writes over a manual name. Says whether
   *  the title took. Published under no client — the server authored it, so
   *  the window running the turn hears it too. */
  async setAutoTitle(id: string, title: string): Promise<boolean> {
    const rows = await this.db.update(sessions).set({ name: title })
      .where(and(eq(sessions.id, id), eq(sessions.nameManual, false)))
      .returning({ id: sessions.id });
    if (rows.length) this.events?.publish(id, '', { event: 'session', name: title });
    return rows.length > 0;
  }

  /** Name a still-unnamed session. A card run's coding session takes its CARD's
   *  title the moment the pair is written — deterministic, instant, no model
   *  call; the card title stays authoritative while set. A name already there
   *  (a person's /rename included) stands. */
  async nameIfUnnamed(id: string, name: string): Promise<void> {
    await this.db.update(sessions).set({ name }).where(and(eq(sessions.id, id), isNull(sessions.name)));
    this.changed(id);
  }

  /** Plan mode: while on, the agent's mutating tools refuse. Published to
   *  EVERY reader of the session feed, the writer included — a turn running
   *  in the window that flipped it must hear it too (the feed drops a
   *  client's own events otherwise). Readers treat a repeat as a no-op. */
  async setPlanMode(id: string, on: boolean): Promise<void> {
    await this.db.update(sessions).set({ planMode: on }).where(eq(sessions.id, id));
    this.events?.publish(id, '', { event: 'session', planMode: on });
  }

  /** The /pin switch: while on, the session sits at the top of every list. */
  async setPinned(id: string, on: boolean): Promise<void> {
    await this.db.update(sessions).set({ pinned: on }).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** The idle digest mentioned this session. */
  async markDigested(id: string, at: Date): Promise<void> {
    await this.db.update(sessions).set({ digestNotifiedAt: at }).where(eq(sessions.id, id));
  }

  /** A tool call on the session: its CHECKOUT was used, whoever's session
   *  it is — a borrower's read keeps the owner's container warm the same as
   *  the owner's own. Background jobs never touch, or nothing goes cold. */
  async touch(s: SessionRow): Promise<void> {
    if (s.workspaceId) await this.workspaces.touch(s.workspaceId);
  }

  /** A cron that names its model: its run's newborn row takes it, so the
   *  record shows what ran and the runner reads the row like every other.
   *  No endpoint: the run inherits the project's while the provider
   *  matches (agentConfig.ts pinned). */
  async stampModel(id: string, m: { provider: string; model: string; reasoning?: string | null }): Promise<void> {
    await this.db.update(sessions).set({ provider: m.provider, model: m.model, baseUrl: null, reasoning: m.reasoning ?? null }).where(eq(sessions.id, id));
    this.events?.publish(id, '', { event: 'session', provider: m.provider, model: m.model, base_url: null });
  }

  // ── holds ──────────────────────────────────────────────────────────────────

  /** Take (or renew) the hold for `client`. One conditional UPDATE — free,
   *  expired, or already mine — so two clients racing cannot both win.
   *  Returns the expiry, or null when someone else holds it. */
  async acquireLock(s: SessionRow, client: string, ttlMs: number, label?: string): Promise<Date | null> {
    const expires = new Date(Date.now() + ttlMs);
    const rows = await this.db.update(sessions)
      .set({ lockedBy: client, lockExpiresAt: expires,
        ...(label !== undefined ? { lockedLabel: label } : {}) })
      .where(and(eq(sessions.id, s.id),
        or(isNull(sessions.lockedBy), eq(sessions.lockedBy, client),
          isNull(sessions.lockExpiresAt), lt(sessions.lockExpiresAt, new Date()))))
      .returning({ id: sessions.id });
    if (!rows.length) return null;
    // Taking over a hold that ran out is the recovery path — and the one
    // moment the previous holder's death is certain. Said in the log (docker
    // logs, the docker_logs tool); the caller's lock event carries it too.
    const died = expiredHold(s);
    if (died && died.by !== client) {
      log.warn({ session: s.id, diedOn: died.label ?? died.by, expiredAt: died.at.toISOString(), takenBy: client },
        'previous turn died mid-turn — its hold expired without a release; session taken over');
    }
    this.changed(s.id);
    return expires;
  }

  /** Release `client`'s hold. Idempotent — releasing what you do not hold
   *  changes nothing. Returns whether anything was released. */
  async releaseLock(id: string, client: string): Promise<boolean> {
    const rows = await this.db.update(sessions)
      .set({ lockedBy: null, lockedLabel: null, lockExpiresAt: null })
      .where(and(eq(sessions.id, id), eq(sessions.lockedBy, client)))
      .returning({ id: sessions.id });
    if (rows.length) this.changed(id);
    return rows.length > 0;
  }

  /** Slide the holder's expiry forward (a save renews the hold). */
  async renewLock(id: string, client: string, ttlMs: number): Promise<Date> {
    const expires = new Date(Date.now() + ttlMs);
    await this.db.update(sessions).set({ lockExpiresAt: expires })
      .where(and(eq(sessions.id, id), eq(sessions.lockedBy, client)));
    return expires;
  }
}
