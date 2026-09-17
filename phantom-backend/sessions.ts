// The session row's ONE owner. Every read and every write of the `sessions`
// table goes through the `Sessions` object below — no route, no engine, no
// job touches the table directly, and this file is the only one in the
// backend that imports it. That is what makes the row's rules real (the pin
// written once, a manual name the titler never overwrites, the lock's
// conditional UPDATE) and what gives a future list feed one place to hang.
//
// A session binds to a workspace and a directory at creation and never
// changes; the id names the directory and the branch.
//
// ONE branch, start to finish: it is checked out at creation, worked in,
// committed to, and pushed back to. Nothing is ever pushed anywhere else. The
// branch is always the session's own {prefix}/{id}, cut from the base branch,
// and is recorded on the row, so it is decided once and never re-derived.
//
// Events: a write that changes a fact a watcher draws (name, plan mode, agent,
// work, the record landing) publishes it here, with the write; EVERY other
// write publishes a bare `session` record — "this row moved" — which is what
// the session LIST feed (GET /sessions/events) is built on, so no writer
// anywhere has to remember to tell the list. Lock events proper stay with
// their callers: a hold means different things to a window (its spinner) and
// to a git sync (nothing to show), so the caller says.
import fs from 'node:fs/promises';
import { and, desc, eq, gte, ilike, inArray, isNull, isNotNull, lt, ne, not, or, count, sql as sqlRaw } from 'drizzle-orm';
import type { Db } from './db/client.js';
// `folders` and `loops` appear here for ONE reason: the list is a JOIN (a
// row's branch and card ride it, and the filter reaches the branch). They
// are read through the join only; their rows are Folders' and Loops' to write.
import { sessions, sessionColumns, folders, loops, tokenUsage, type SessionRow } from './db/schema.js';
import type { Settings } from './settings.js';
import type { Workspaces } from './workspaces.js';
import type { Folders } from './folders.js';
import { git, cloneFresh, checkoutBranch, classifyGitFailure, localState } from './git/git.js';
import { claimSlot, resolveAuth } from './pool/pool.js';
import { sessionDir, repoDir, type Paths } from './pool/paths.js';
import { newId } from '../core/ids.js';
import { logger } from './log.js';
import { lastUserFromJsonl, sumUsageFromJsonl, stripUsageFromJsonl } from '../core/llm/transcript.js';
import { cascade } from '../core/llm/agentConfig.js';
import { sessionScope } from './store.js';
import type { SessionEvents } from './api/sessionEvents.js';

const log = logger('sessions');

export class SessionError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

/** A session with its folder's facts joined in — what the API serves, so
 *  clients keep seeing `branch` even though sessions no longer carry it. */
export type SessionFull = SessionRow & { branch: string; claimSha: string };

/** The list's preview of the last thing the user typed: a few dozen
 *  characters on screen, so this many stored — never the record. */
export const LAST_MESSAGE_CHARS = 200;

/** The looper's client id — the one holder whose saves are the loop's own
 *  turns. The engine locks with it, the release hook ignores it, and the
 *  transcript save reads who drove the turn off it. */
export const LOOP_CLIENT_ID = 'supervisor';

export type TokenUsage = { input: number; output: number; cache_read: number; cache_write: number };
export type WorkState = 'not_pushed' | 'not_merged' | 'merged';

/** What GET /sessions accepts — the object owns what the list IS: the
 *  filters and the count share one WHERE, so `total` is exactly the rows the
 *  pages add up to. */
export interface ListQuery {
  /** Only sessions something was typed into (a last message exists). */
  typed?: boolean;
  /** false = leave out the looper's supervisor seats. */
  supervisor?: boolean;
  /** One substring, case-insensitive, anywhere in the name, the last user
   *  message or the branch. */
  q?: string;
  limit?: number;
  /** The cursor: the whole sort key of the last row the client saw. */
  before?: Date;
  beforeId?: string;
  beforePinned?: boolean;
}

/** A list row: the session plus the two facts it does not carry itself —
 *  its folder's branch and its loop's card. */
export type ListedSession = SessionRow & { branch: string | null; card: number | null };

// ── Pure rules — no row in hand, nothing to await ────────────────────────────

/** A session that holds only its conversation — no checkout, no container,
 *  nothing on disk. Supervisor (the looper's verdict record) and assistant
 *  (the voice/Telegram conversation) are both this shape. */
export const conversationOnly = (s: SessionRow): boolean =>
  s.agent === 'supervisor' || s.agent === 'assistant';

/** Duplicating copies a conversation into a fresh checkout — meaningless for
 *  a record that has no checkout and belongs to its card's run. */
export function assertDuplicable(s: SessionRow): void {
  if (conversationOnly(s)) {
    throw new SessionError('invalid_args',
      "a supervisor session is its card's verdict record — duplicate the card's coding session instead");
  }
}

/** Held right now by someone who is not `client`? An expired hold is no hold. */
export const heldByOther = (s: SessionRow, client: string): boolean =>
  !!s.lockedBy && s.lockedBy !== client
  && !!s.lockExpiresAt && s.lockExpiresAt.getTime() > Date.now();

/** `sessions.agent` after `client` saved a turn: WHO DROVE THE LAST TURN.
 *  The supervisor's record is the supervisor's for life (read-only in every
 *  client). The coder's seat is 'coding' while the loop's turns land in it and
 *  a PERSON's (null) the moment anyone else's does — typing into a card's
 *  session takes it over; the loop takes it back the next time it drives.
 *  Read off the writer's identity at the record's one door, never off a
 *  client's claim, which is what keeps the column trustworthy. */
export function agentAfterSave(current: string | null, client: string): 'coding' | 'supervisor' | null {
  if (current === 'supervisor') return 'supervisor';
  return client === LOOP_CLIENT_ID ? 'coding' : null;
}

/** The first line of a transcript is its header; a duplicate keeps the frozen
 *  system prompt but is a different session on a different branch, so those
 *  two fields are rewritten. An unparsable first line is left alone — the
 *  loader skips what it cannot parse, same as everywhere. */
export function rewriteTranscriptHeader(
  data: string,
  patch: { session_id: string; branch: string },
): string {
  const nl = data.indexOf('\n');
  const first = nl < 0 ? data : data.slice(0, nl);
  try {
    const h = JSON.parse(first) as { type?: string };
    if (h.type !== 'session') return data;
    const line = JSON.stringify({ ...h, ...patch });
    return nl < 0 ? line : line + data.slice(nl);
  } catch { return data; }
}

// ── The object ───────────────────────────────────────────────────────────────

export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly paths: Paths,
    private readonly settings: Settings,
    private readonly workspaces: Workspaces,
    private readonly folders: Folders,
    /** The per-session feed; absent in tests that have no watchers. */
    private readonly events?: SessionEvents,
  ) {}

  /** The row moved in a way no richer event names: the list re-reads. Under
   *  no client, so every listener hears it (the feed drops a client's own). */
  private changed(id: string): void { this.events?.publish(id, '', { event: 'session' }); }

  // ── the model ──────────────────────────────────────────────────────────────
  // THE RULE: a session's model is its row's provider/model/base_url, and
  // nothing else. Written when the session is born (from the settings, per
  // workspace; a duplicate takes its source's). While nothing has been said —
  // turn_count 0 — the row follows the settings, so /model and a preset reach
  // a session you have not spoken to yet. The first saved turn moves the
  // count to 1 and the row never changes again. Every runner reads the row.

  /** What a session born in this workspace runs on right now. `agent` picks
   *  the cascade (the supervisor's / assistant's trio, else the coding one). */
  private async birthModel(workspaceId: string, agent: 'supervisor' | 'assistant' | null = null):
  Promise<{ provider: string | null; model: string | null; baseUrl: string | null }> {
    const workspace = await this.workspaces.get(workspaceId);
    const cfg = await this.settings.resolveMany(['provider', 'model', 'base_url',
      'supervisor_provider', 'supervisor_model', 'supervisor_base_url',
      'assistant_provider', 'assistant_model', 'assistant_base_url'], workspace ? { workspace } : {});
    if (agent) {
      try { return cascade(cfg, agent); } catch { /* nothing usable yet — the row stays empty */ }
    }
    return { provider: cfg.provider ?? null, model: cfg.model ?? null, baseUrl: cfg.base_url ?? null };
  }

  /** A setting changed: every session with nothing said yet (and no turn in
   *  flight) takes the settings' model now. The row change goes out on the
   *  session feed, so a window showing that session repaints from it. */
  async followModelSettings(): Promise<void> {
    const rows = await this.db.select(sessionColumns).from(sessions)
      .where(and(eq(sessions.status, 'active'), eq(sessions.turnCount, 0)));
    const now = Date.now();
    for (const s of rows) {
      if (s.lockedBy && s.lockExpiresAt && s.lockExpiresAt.getTime() > now) continue;
      const m = await this.birthModel(s.workspaceId, s.agent as 'supervisor' | 'assistant' | null);
      if (m.provider === s.provider && m.model === s.model && m.baseUrl === s.baseUrl) continue;
      await this.db.update(sessions).set(m).where(eq(sessions.id, s.id));
      this.events?.publish(s.id, '', { event: 'session', provider: m.provider, model: m.model, base_url: m.baseUrl });
    }
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async get(id: string): Promise<SessionRow | undefined> {
    const rows = await this.db.select(sessionColumns).from(sessions).where(eq(sessions.id, id));
    return rows[0];
  }

  /** The stored conversation (JSONL), or null when none was ever saved. The
   *  one read that names the blob on purpose. */
  async transcript(id: string): Promise<string | null> {
    const rows = await this.db.select({ data: sessions.transcript }).from(sessions).where(eq(sessions.id, id));
    return rows[0]?.data ?? null;
  }

  /** When the record last moved — the stamp a turn compares before running. */
  async transcriptStamp(id: string): Promise<Date | null> {
    const rows = await this.db.select({ updatedAt: sessions.transcriptUpdatedAt }).from(sessions)
      .where(eq(sessions.id, id));
    return rows[0]?.updatedAt ?? null;
  }

  /** GET /sessions: pinned first, then newest activity first, destroyed rows
   *  included (status says which). Assistant sessions are tracked for tokens,
   *  not for the list — always left out. `total` counts the same WHERE. */
  async list(q: ListQuery): Promise<{ sessions: ListedSession[]; total: number }> {
    const filters = [];
    if (q.typed === true) filters.push(isNotNull(sessions.lastUserMessage));
    if (q.supervisor === false) filters.push(or(isNull(sessions.agent), ne(sessions.agent, 'supervisor')));
    // ONE substring, wherever it appears — no word splitting, no ranking; the
    // list keeps its order and just gets shorter. `%` and `_` are LIKE's own
    // wildcards, so typed ones are escaped.
    const text = q.q?.trim();
    if (text) {
      const needle = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(or(ilike(sessions.name, needle), ilike(sessions.lastUserMessage, needle), ilike(folders.branch, needle)));
    }
    filters.push(or(isNull(sessions.agent), ne(sessions.agent, 'assistant')));
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
            ? or(lt(sessions.lastUsedAt, cut), and(eq(sessions.lastUsedAt, cut), lt(sessions.id, q.beforeId)))
            : lt(sessions.lastUsedAt, cut)))
      : undefined;
    // Token totals: LEFT JOIN token_usage and SUM — the table is the single
    // source of truth, the session row's cached columns are being phased out.
    let page = this.db
      .select({
        ...sessionColumns, branch: folders.branch, card: loops.card,
        tokensInput: sqlRaw<number>`coalesce(sum(${tokenUsage.tokensInput}), 0)`.as('tokens_input'),
        tokensOutput: sqlRaw<number>`coalesce(sum(${tokenUsage.tokensOutput}), 0)`.as('tokens_output'),
        tokensCacheRead: sqlRaw<number>`coalesce(sum(${tokenUsage.tokensCacheRead}), 0)`.as('tokens_cache_read'),
        tokensCacheWrite: sqlRaw<number>`coalesce(sum(${tokenUsage.tokensCacheWrite}), 0)`.as('tokens_cache_write'),
      })
      .from(sessions)
      .leftJoin(folders, eq(folders.id, sessions.folderId))
      .leftJoin(loops, or(eq(loops.codingSessionId, sessions.id), eq(loops.supervisorSessionId, sessions.id)))
      .leftJoin(tokenUsage, eq(tokenUsage.sessionId, sessions.id))
      .where(and(...filters, ...(cursor ? [cursor] : [])))
      .groupBy(sessions.id, folders.branch, loops.card)
      .orderBy(desc(sessions.pinned), desc(sessions.lastUsedAt), desc(sessions.id))
      .$dynamic();
    if (q.limit) page = page.limit(q.limit);
    const [rows, [{ total }]] = await Promise.all([
      page,
      // The same joins as the page: the filters reach folders (branch).
      this.db.select({ total: count() }).from(sessions)
        .leftJoin(folders, eq(folders.id, sessions.folderId))
        .where(and(...filters)),
    ]);
    return { sessions: rows, total };
  }

  /** Every active session — the disk sweep's protected set. */
  async listActive(): Promise<SessionRow[]> {
    return this.db.select(sessionColumns).from(sessions).where(eq(sessions.status, 'active'));
  }

  /** Among `candidates`, return the IDs whose lastUsedAt is older than `idleMs`
   *  ago — the idle set. The caller intersects this with running containers and
   *  running commands to decide what to reap. */
  async listIdle(candidates: string[], idleMs: number): Promise<string[]> {
    if (!candidates.length) return [];
    const cutoff = new Date(Date.now() - idleMs);
    const rows = await this.db.select({ id: sessions.id }).from(sessions)
      .where(and(inArray(sessions.id, candidates), lt(sessions.lastUsedAt, cutoff)));
    return rows.map((r) => r.id);
  }

  /** A workspace's active sessions — what stands in the way of deleting it. */
  async listActiveIn(workspaceId: string): Promise<SessionRow[]> {
    return this.db.select(sessionColumns).from(sessions)
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, 'active')));
  }

  /** The rows the work-state refresh walks: the sessions named, with the
   *  facts the walk needs and nothing else. */
  async listForWorkRefresh(ids: string[]): Promise<Pick<SessionRow, 'id' | 'folderId' | 'workspaceId' | 'work'>[]> {
    if (!ids.length) return [];
    return this.db.select({
      id: sessions.id, folderId: sessions.folderId, workspaceId: sessions.workspaceId, work: sessions.work,
    }).from(sessions).where(inArray(sessions.id, ids));
  }

  /** Sessions whose `work` is stale: non-null but no longer backed by a
   *  running container. The refresh clears these to null. */
  async listStaleWork(activeIds: string[]): Promise<Pick<SessionRow, 'id' | 'workspaceId' | 'work'>[]> {
    const where = activeIds.length
      ? and(isNotNull(sessions.work), not(inArray(sessions.id, activeIds)))
      : isNotNull(sessions.work);
    return this.db.select({
      id: sessions.id, workspaceId: sessions.workspaceId, work: sessions.work,
    }).from(sessions).where(where);
  }

  /** A batch of rows by id — the board names each card's session, its hold
   *  and its work state off these. */
  async getMany(ids: string[]): Promise<Map<string, SessionRow>> {
    if (!ids.length) return new Map();
    const rows = await this.db.select(sessionColumns).from(sessions).where(inArray(sessions.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Sessions that finished and went quiet: a record exists, nobody holds
   *  them, idle past `threshold`, and not digested since they last moved. */
  async listIdleSince(threshold: Date): Promise<SessionRow[]> {
    return this.db.select(sessionColumns).from(sessions).where(
      and(
        isNull(sessions.lockedBy),
        lt(sessions.transcriptUpdatedAt, threshold),
        or(
          isNull(sessions.digestNotifiedAt),
          sqlRaw`${sessions.transcriptUpdatedAt} > ${sessions.digestNotifiedAt}`,
        ),
      ),
    );
  }

  /** Token totals per provider/model over every session used since `since`
   *  (destroyed rows left out) — /system/token-usage. */
  async tokenUsageByModel(since: Date): Promise<Array<{ provider: string | null; model: string | null;
    input: number; output: number; cacheRead: number; cacheWrite: number }>> {
    const rows = await this.db
      .select({
        provider: sessions.provider,
        model: sessions.model,
        input: sqlRaw<number>`coalesce(sum(${sessions.tokensInput}), 0)`.as('input'),
        output: sqlRaw<number>`coalesce(sum(${sessions.tokensOutput}), 0)`.as('output'),
        cacheRead: sqlRaw<number>`coalesce(sum(${sessions.tokensCacheRead}), 0)`.as('cache_read'),
        cacheWrite: sqlRaw<number>`coalesce(sum(${sessions.tokensCacheWrite}), 0)`.as('cache_write'),
      })
      .from(sessions)
      .where(and(ne(sessions.status, 'destroyed'), gte(sessions.lastUsedAt, since)))
      .groupBy(sessions.provider, sessions.model);
    // PostgreSQL sum() on bigint → string; coerce at the boundary.
    return rows.map((r) => ({ ...r, input: Number(r.input), output: Number(r.output),
      cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite) }));
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Create a session: claim a warm slot or clone directly — one way to obtain a
   *  workspace, not a fast path for some callers and a slow one for others. The
   *  claim fetch is what makes the result CORRECT; pool refresh only makes it
   *  small. Record where base was (claim_sha) for `/git/status`.
   *
   *  Passing `id` restarts an existing session. Destroy deletes a session's FILES
   *  and nothing else — the row keeps its id and its branch — so a restart needs
   *  no extra state: the same id names the same branch, checkoutBranch finds it on
   *  origin, and the session carries on exactly where it stopped.
   *
   *  `fromBranch` changes only the new branch's CUT POINT (the duplicate route):
   *  the folder is still obtained the one way — pool claim or clone off base —
   *  but the session branch is cut from origin's copy of `fromBranch` instead of
   *  from base. A missing ref is a hard error, never a silent fall back to base:
   *  the caller flushed the source to origin first, so absent means something
   *  is wrong, and a copy that quietly starts at base loses the work. */
  async create(workspaceId: string, opts: { id?: string; fromBranch?: string } = {}): Promise<SessionFull> {
    const workspace = await this.workspaces.get(workspaceId);
    if (!workspace) throw new SessionError('not_found', `no workspace ${workspaceId}`);

    const prior = opts.id
      ? (await this.db.select(sessionColumns).from(sessions).where(eq(sessions.id, opts.id)))[0]
      : undefined;
    if (prior && prior.workspaceId !== workspaceId) {
      throw new SessionError('workspace_mismatch', `session ${prior.id} belongs to another workspace`);
    }
    // An active session still owns its directory; rebuilding it underneath would
    // delete work that has not been pushed yet.
    if (prior && prior.status === 'active') {
      throw new SessionError('already_active', `session ${prior.id} is still active`);
    }
    // A conversation-only session has no files — there is nothing to restart.
    if (prior && conversationOnly(prior)) {
      throw new SessionError('invalid_args',
        'a supervisor session holds only its conversation — there are no files to restart; the looper creates these');
    }
    // A cut point belongs to a NEW session alone: a restart's start point is the
    // branch the folder remembers, never a second opinion.
    if (prior && opts.fromBranch) {
      throw new SessionError('invalid_args', 'fromBranch cuts a NEW session\'s branch — a restart has its own');
    }

    const id = prior?.id ?? opts.id ?? newId();
    const dest = sessionDir(this.paths, id);
    const dir = repoDir(this.paths, id);
    const auth = await resolveAuth(this.settings, workspace);
    // A restart uses the branch the FOLDER remembers — the work is on it. The
    // folder shares the session's id, so directories keep their names.
    const priorFolder = prior?.folderId ? await this.folders.get(prior.folderId) : undefined;
    const branch = priorFolder?.branch ?? `${workspace.branchPrefix}/${id}`;

    // Everything from here to the checkout talks to the remote, and a remote
    // failure has a MEANING a person can act on — a dead token, a repo the token
    // cannot see, GitHub unreachable. Classified into a SessionError so the API
    // answers with that meaning; anything unrecognised keeps its own error.
    let found: 'existing' | 'new';
    let claimSha: string;
    let claimed: boolean;
    try {
      claimed = await claimSlot(this.paths, workspace.owner, workspace.name, workspace.baseBranch, dest);
      if (claimed) {
        // Pool slots are pristine by construction, so the unguarded catch-up is
        // safe — and mandatory: a slot stocked days ago is days behind.
        await git(dir, ['fetch', 'origin', workspace.baseBranch], auth);
        await git(dir, ['reset', '--hard', `origin/${workspace.baseBranch}`]);
      } else {
        const depth = await this.settings.resolve('initial_history_depth', { workspace });
        await cloneFresh(dir, auth, workspace.baseBranch, depth);
        await fs.mkdir(`${dest}/scratch`, { recursive: true });
      }
      await fs.mkdir(`${dest}/logs`, { recursive: true }); // detached exec logs — outside workspace/, or add -A commits them

      // --depth implies --single-branch: the clone's fetch refspec covers ONLY the
      // base branch, so without this a push to the session branch would update no
      // tracking ref and every origin/<branch> ancestry check would read as
      // no_upstream forever. One added refspec scopes tracking to exactly this
      // session's branch; on base there is nothing to add.
      if (branch !== workspace.baseBranch) {
        await git(dir, ['config', '--add', 'remote.origin.fetch',
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      }
      if (opts.fromBranch) {
        // Cut the session branch from origin's copy of the source branch. The
        // duplicate route flushed it there first; "no such ref" therefore means
        // the work never made it to origin, which is an error — checking out
        // from base instead would silently lose it.
        try {
          await git(dir, ['fetch', 'origin', `+refs/heads/${opts.fromBranch}:refs/remotes/origin/${opts.fromBranch}`], auth);
        } catch (e) {
          const msg = String((e as { stderr?: string }).stderr ?? e);
          if (/couldn't find remote ref|not found in upstream|no such ref/i.test(msg)) {
            throw new SessionError('source_branch_gone',
              `the source branch ${opts.fromBranch} is not on origin — its work never made it there, so there is nothing to copy`);
          }
          throw e;
        }
        await git(dir, ['checkout', '-B', branch, `refs/remotes/origin/${opts.fromBranch}`]);
        found = 'new';
      } else {
        found = await checkoutBranch(dir, branch, auth);
      }
      const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
      claimSha = stdout.trim();
    } catch (e) {
      const why = classifyGitFailure(e, { hadToken: !!auth.pat });
      if (why) throw new SessionError(why.code, `cannot check out ${workspace.owner}/${workspace.name}: ${why.message}`, why.retryable);
      throw e;
    }

    if (prior) {
      await this.db.update(sessions).set({ status: 'active', lastUsedAt: new Date() })
        .where(eq(sessions.id, prior.id));
      log.info({ session: id, branch, found }, 'session restarted');
      this.changed(prior.id);
      const row = (await this.db.select(sessionColumns).from(sessions).where(eq(sessions.id, prior.id)))[0];
      return { ...row, branch, claimSha: priorFolder?.claimSha ?? claimSha };
    }

    // The folder (the checkout's identity: branch + claim) and the session (the
    // conversation) are born together, sharing the id.
    await this.folders.create({ id, workspaceId, branch, claimSha });
    await this.db.insert(sessions).values({ id, workspaceId, status: 'active', folderId: id,
      ...await this.birthModel(workspaceId) });
    const row = (await this.db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)))[0];
    log.info({ session: id, workspace: `${workspace.owner}/${workspace.name}`, branch, found, claimed, claimSha },
      'session created');
    this.changed(id);
    return { ...row, branch, claimSha };
  }

  /** A conversation-only session: no checkout of its own — `folderId` points at
   *  another session's folder (the files it can read), or is null when there is
   *  nothing to read. The shared base for supervisor and assistant sessions. */
  async createConversation(
    workspaceId: string, opts: { agent: 'supervisor' | 'assistant'; folderId?: string | null },
  ): Promise<SessionRow> {
    const id = newId();
    await this.db.insert(sessions).values({
      id, workspaceId, status: 'active', agent: opts.agent,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...await this.birthModel(workspaceId, opts.agent),
    });
    this.changed(id);
    return (await this.get(id))!;
  }

  /** The supervisor's conversation-only session: no folder of its own — its
   *  folder_id points at the coder's, which is where the files are. */
  createSupervisor(workspaceId: string, folderId: string): Promise<SessionRow> {
    return this.createConversation(workspaceId, { agent: 'supervisor', folderId });
  }

  /** The assistant's conversation-only session: workspace and folder track
   *  whatever the user is looking at, updated as they switch. */
  createAssistant(workspaceId: string, folderId?: string | null): Promise<SessionRow> {
    return this.createConversation(workspaceId, { agent: 'assistant', folderId });
  }

  /** What travels from a source into its freshly created copy (the duplicate
   *  route): the conversation minus its usage lines, the preview, the name,
   *  plan mode and the MODEL — the copy runs on what the source ran on, and
   *  can be moved with /model or a preset until its first new message
   *  (turn_count 0, like any newborn). NO token totals — the usage lines are
   *  stripped, so the copy counts its own spend from birth. */
  async seedCopy(copy: SessionFull, src: SessionRow): Promise<void> {
    const data = await this.transcript(src.id);
    const stamp = new Date();
    await this.db.update(sessions).set({
      planMode: src.planMode,
      ...(src.provider && src.model ? { provider: src.provider, model: src.model, baseUrl: src.baseUrl } : {}),
      ...(data != null ? {
        transcript: stripUsageFromJsonl(rewriteTranscriptHeader(data, { session_id: copy.id, branch: copy.branch })),
        lastUserMessage: src.lastUserMessage, name: src.name, nameManual: src.nameManual,
        transcriptUpdatedAt: stamp,
      } : {}),
    }).where(eq(sessions.id, copy.id));
    this.changed(copy.id);
  }

  /** Explicit delete honors the request even when work would be lost — that is
   *  the caller's decision to make. The automatic sweep (disk.ts) never does.
   *  Deletes the session's FILES and nothing else — the row keeps its id and
   *  its branch, so `create` with the same id restarts it where it stopped. */
  async destroy(session: SessionRow, opts: { force: boolean }): Promise<void> {
    // A session that does not OWN its folder (the supervisor's, an orphan) has
    // no files of its own: mark it and stop.
    if (session.folderId !== session.id) {
      await this.db.update(sessions).set({ status: 'destroyed' }).where(eq(sessions.id, session.id));
      log.info({ session: session.id }, 'conversation-only session destroyed (no files)');
      this.changed(session.id);
      return;
    }
    const folder = await this.folders.get(session.folderId);
    const dir = repoDir(this.paths, session.id);
    const state = folder
      ? await localState(dir, folder.branch).catch(() => 'unknown' as const)
      : 'clean' as const;
    if (state !== 'clean' && !opts.force) {
      log.warn({ session: session.id, state }, 'destroy would discard work — refusing (pass force)');
      throw new SessionError('unpushed_work', `session holds ${state} work; delete with force=true to discard`);
    }
    await fs.rm(sessionDir(this.paths, session.id), { recursive: true, force: true });
    await this.db.update(sessions).set({ status: 'destroyed' }).where(eq(sessions.id, session.id));
    log.info({ session: session.id, state }, 'session destroyed');
    this.changed(session.id);
  }

  /** The row goes for good — its overrides with it, the transcript on it.
   *  Only its pushed branch on origin survives. Files first (`destroy`). */
  async purge(id: string): Promise<void> {
    await this.settings.dropScope(sessionScope(id));
    await this.db.delete(sessions).where(eq(sessions.id, id));
    this.changed(id);
  }

  // ── the record ─────────────────────────────────────────────────────────────

  /** A client's turn ended and the whole transcript lands: one statement
   *  writes the text, the list preview and the turn count (the count leaving
   *  0 is what freezes the row's model). `client` is who wrote it: the agent
   *  seat follows the writer (agentAfterSave), and the record event carries
   *  the id so the writer ignores its own echo. Returns what the naming
   *  decision needs. */
  async saveTranscript(s: SessionRow, data: string, client: string): Promise<{
    stamp: Date; agent: 'coding' | 'supervisor' | null;
    name: string | null; turnCount: number; nameManual: boolean;
  }> {
    // A list preview, not the record: the UI shows a few dozen characters,
    // and an uncapped copy of a pasted wall of text would ride every
    // GET /sessions response for the life of the session.
    const lastUserMessage = lastUserFromJsonl(data)?.slice(0, LAST_MESSAGE_CHARS) ?? null;
    const stamp = new Date();
    // Token totals are per-step rows in the token_usage table — the list
    // query JOINs that table directly. No re-parsing, no row cache.
    // Every save is one turn: the counter that paces session naming.
    const agent = agentAfterSave(s.agent, client);
    const [saved] = await this.db.update(sessions)
      .set({ transcript: data, lastUserMessage, transcriptUpdatedAt: stamp,
        turnCount: sqlRaw`${sessions.turnCount} + 1`, agent,
        // Saving a turn is activity: the session stays off the idle sweep.
        lastUsedAt: stamp,
      })
      .where(eq(sessions.id, s.id))
      .returning({ name: sessions.name, turnCount: sessions.turnCount, nameManual: sessions.nameManual });
    // The record landed: the one moment a client can trust that the server's
    // copy moved. Watchers pull the transcript on this. `by` is the writer,
    // so the window that just uploaded its OWN turn ignores the echo instead
    // of re-pulling and repainting the reply it already drew.
    this.events?.publish(s.id, client, { event: 'transcript', updated_at: stamp.toISOString(), by: client });
    if (agent !== s.agent) this.events?.publish(s.id, client, { event: 'session', agent });
    return { stamp, agent, name: saved.name, turnCount: saved.turnCount, nameManual: saved.nameManual };
  }

  /** Step-level save: updates ONLY the transcript text and lastUsedAt.
   *  No turn count bump, no naming, no transcript event.
   *  The lightweight per-step counterpart to saveTranscript. */
  async stepSave(id: string, data: string): Promise<Date> {
    const stamp = new Date();
    await this.db.update(sessions)
      .set({ transcript: data, transcriptUpdatedAt: stamp, lastUsedAt: stamp })
      .where(eq(sessions.id, id));
    return stamp;
  }

  /** A turn began on the session with `message` — the moment the list's
   *  preview can move (the save at turn end used to be the first chance) and,
   *  on a session's FIRST message, the moment to name it. Says whether it is
   *  that first message: unnamed, never a turn saved, not a loop seat (a loop
   *  session's first message is the loop's fixed kickoff text, which would
   *  name every card's session after the kickoff; those are named off the
   *  save, where the reply is in). Manual names are never in play here — a
   *  renamed session is never unnamed. */
  async turnStarted(id: string, message: string): Promise<{ firstMessage: boolean }> {
    const rows = await this.db.update(sessions)
      .set({ lastUserMessage: message.slice(0, LAST_MESSAGE_CHARS) })
      .where(eq(sessions.id, id))
      .returning({ name: sessions.name, turnCount: sessions.turnCount, agent: sessions.agent });
    const r = rows[0];
    this.changed(id);
    return { firstMessage: !!r && r.name === null && r.turnCount === 0 && r.agent === null };
  }

  /** A row older than the save-time token write (or a duplicate's copy,
   *  whose usage lines were stripped) carries nulls: sum the record once,
   *  write the sums, and never again. Returns what was written. */
  async backfillTokens(s: SessionRow & { transcriptUpdatedAt: Date }): Promise<TokenUsage> {
    const totals = sumUsageFromJsonl((await this.transcript(s.id)) ?? '');
    await this.db.update(sessions).set({
      tokensInput: totals.input, tokensOutput: totals.output,
      tokensCacheRead: totals.cache_read, tokensCacheWrite: totals.cache_write,
      tokensAsOf: s.transcriptUpdatedAt,
    }).where(eq(sessions.id, s.id));
    this.changed(s.id);
    return totals;
  }

  /** Add a turn's token usage to a session's running totals. Incremental — each
   *  call adds to the existing sums, so turns update the row without re-reading
   *  the whole transcript. Also touches lastUsedAt and counts the turn. */
  async addUsage(id: string, usage: TokenUsage): Promise<void> {
    const stamp = new Date();
    const s = await this.get(id);
    if (!s) return;
    await this.db.update(sessions).set({
      tokensInput: (s.tokensInput ?? 0) + usage.input,
      tokensOutput: (s.tokensOutput ?? 0) + usage.output,
      tokensCacheRead: (s.tokensCacheRead ?? 0) + usage.cache_read,
      tokensCacheWrite: (s.tokensCacheWrite ?? 0) + usage.cache_write,
      tokensAsOf: stamp,
      lastUsedAt: stamp,
      turnCount: sqlRaw`${sessions.turnCount} + 1`,
    }).where(eq(sessions.id, id));
    this.changed(id);
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

  /** Name a still-unnamed session. The loop's coder seat takes its CARD's
   *  title the moment the pair is written — deterministic, instant, no model
   *  call; the card title stays authoritative while set. A name already there
   *  (a person's /rename included) stands. */
  async nameIfUnnamed(id: string, name: string): Promise<void> {
    await this.db.update(sessions).set({ name }).where(and(eq(sessions.id, id), isNull(sessions.name)));
    this.changed(id);
  }

  /** The cli's /plan switch: while on, clients build the coding agent's
   *  mutating kits with the readonly preset. */
  async setPlanMode(id: string, on: boolean, by: string): Promise<void> {
    await this.db.update(sessions).set({ planMode: on }).where(eq(sessions.id, id));
    this.events?.publish(id, by, { event: 'session', planMode: on });
  }

  /** The /pin switch: while on, the session sits at the top of every list. */
  async setPinned(id: string, on: boolean): Promise<void> {
    await this.db.update(sessions).set({ pinned: on }).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** Where the session's work stands, as the git refresh measured it. A
   *  watcher's work-state dot follows the event. */
  async setWork(id: string, work: WorkState | null): Promise<void> {
    await this.db.update(sessions).set({ work }).where(eq(sessions.id, id));
    this.events?.publish(id, '', { event: 'session', work });
  }

  /** The branch reached origin. */
  async markPushed(id: string): Promise<void> {
    await this.db.update(sessions).set({ lastPushAt: new Date() }).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** The idle digest mentioned this session. */
  async markDigested(id: string, at: Date): Promise<void> {
    await this.db.update(sessions).set({ digestNotifiedAt: at }).where(eq(sessions.id, id));
  }

  /** Tool calls count as use; background jobs do not, or nothing ever goes cold. */
  async touch(id: string): Promise<void> {
    await this.db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** Tag a conversation with who drives it. The loop stamps its coder seat at
   *  every turn START (so the row is right while the turn runs); the transcript
   *  save re-derives it from the writer at turn END (agentAfterSave). */
  async stampAgent(id: string, agent: 'coding' | 'supervisor'): Promise<void> {
    await this.db.update(sessions).set({ agent }).where(eq(sessions.id, id));
    this.changed(id);
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
    if (rows.length) this.changed(s.id);
    return rows.length ? expires : null;
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
