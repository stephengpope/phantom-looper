// The session row's ONE owner. Every read and every write of the `sessions`
// table goes through the `Sessions` object below — no route, no engine, no
// job touches the table directly, and this file is the only one in the
// backend that imports it. That is what makes the row's rules real (the pin
// written once, a manual name the titler never overwrites, the lock's
// conditional UPDATE) and what gives a future list feed one place to hang.
//
// A session is a CONVERSATION. It uses one FOLDER (folder_id) — the
// checkout: files, branch, container. A coder's folder is its own (same id),
// a supervisor's is its coder's, the assistant's is the on-screen session's.
// The checkout's facts — files present, last touched, last pushed, git state
// — are the folder's (Folders); every read here joins them in (`view`), so
// the row a caller gets carries `status`, `lastUsedAt`, `lastPushAt`,
// `work` and `branch` as before. `folderOf` is the ONE answer to "which
// folder does this session use".
//
// Events: a write that changes a fact a watcher draws (name, plan mode, agent,
// the record landing) publishes it here, with the write; EVERY other write
// publishes a bare `session` record — "this row moved" — which is what the
// session LIST feed (GET /sessions/events) is built on, so no writer anywhere
// has to remember to tell the list. The folder's writes (touch, work, push)
// publish the same way under the folder's id (Folders). Lock events proper
// stay with their callers: a hold means different things to a window (its
// spinner) and to a git sync (nothing to show), so the caller says.
import { and, desc, eq, ilike, inArray, isNull, isNotNull, lt, ne, not, or, count, sql as sqlRaw } from 'drizzle-orm';
import type { Db } from './db/client.js';
import type { PgColumn } from 'drizzle-orm/pg-core';
// `folders` and `cards` appear here for JOINs only: every session read
// carries its folder's checkout facts, the list carries the card number and
// column, the card reads take a number. Their rows are Folders' and Cards'
// to write.
import { sessions, sessionColumns, folders, cards, logTokens, type SessionRow } from './db/schema.js';
import type { Settings } from './settings.js';
import type { Workspaces } from './workspaces.js';
import type { Folders } from './folders.js';
import { newId } from '../core/ids.js';
import { logger } from './log.js';
import { lastUserFromJsonl, stripUsageFromJsonl } from '../core/llm/transcript.js';
import type { CodingPrompt } from '../core/llm/agents/coding.js';
import { cascade } from '../core/llm/agentConfig.js';
import type { SessionEvents } from './api/sessionEvents.js';

const log = logger('sessions');

export class SessionError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

/** A freshly created session: its folder's branch is known and the commit
 *  it was cut from rides along for the response. */
export type SessionFull = SessionRow & { branch: string; cutFromSha: string };

/** The list's preview of the last thing the user typed: a few dozen
 *  characters on screen, so this many stored — never the record. */
export const LAST_MESSAGE_CHARS = 200;

/** The looper's client id — the one holder whose saves are the loop's own
 *  turns. The engine locks with it, the release hook ignores it, and the
 *  transcript save reads who drove the turn off it. */
export const LOOP_CLIENT_ID = 'supervisor';

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

/** A list row: the session plus its card's number and the card's column. */
export type ListedSession = SessionRow & { card: number | null; cardStatus: string | null };

// ── Pure rules — no row in hand, nothing to await ────────────────────────────

/** A session that holds only its conversation — no checkout, no container,
 *  nothing on disk. Supervisor (the looper's verdict record) and assistant
 *  (the voice/Telegram conversation) are both this shape. */
export const conversationOnly = (s: SessionRow): boolean =>
  s.agent === 'supervisor' || s.agent === 'assistant';

/** The rows that are coding sessions: a coder's seat ('coding') or a
 *  person's (null) — never a supervisor's record or the assistant's. The
 *  SQL twin of `!conversationOnly`. */
const isCodingSession = or(isNull(sessions.agent), not(inArray(sessions.agent, ['supervisor', 'assistant'])));

/** Duplicating copies a conversation into a fresh checkout — meaningless for
 *  a record that has no checkout and belongs to its card's run. */
export function assertDuplicable(s: SessionRow): void {
  if (conversationOnly(s)) {
    throw new SessionError('invalid_args',
      "a supervisor session is its card's verdict record — duplicate the card's coding session instead");
  }
}

/** THE folder this session's tools open. Null only on an assistant with no
 *  session on screen yet — then there are no files, and a caller that needs
 *  them is refused; nothing ever falls back to the session's own id. */
export function folderOf(s: Pick<SessionRow, 'id' | 'folderId'>): string {
  if (!s.folderId) throw new SessionError('no_folder', `session ${s.id} has no folder — nothing to read`);
  return s.folderId;
}

/** Does the session own its files — is the folder its own? A coder does; a
 *  supervisor and the assistant borrow another's. Only an owner has files to
 *  destroy, restart, back up or sweep. */
export const ownsFolder = (s: Pick<SessionRow, 'id' | 'folderId'>): boolean => s.folderId === s.id;

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

// ── The object ───────────────────────────────────────────────────────────────

export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly workspaces: Workspaces,
    private readonly folders: Folders,
    /** The per-session feed; absent in tests that have no watchers. */
    private readonly events?: SessionEvents,
  ) {}

  /** The row moved in a way no richer event names: the list re-reads. Under
   *  no client, so every listener hears it (the feed drops a client's own). */
  private changed(id: string): void { this.events?.publish(id, '', { event: 'session' }); }

  // ── the view ───────────────────────────────────────────────────────────────
  // A session read is the row plus its folder's checkout facts. ONE select
  // shape and ONE join, used by every read below, so `status`, `lastUsedAt`,
  // `lastPushAt`, `work` and `branch` mean the same thing everywhere.

  /** The files' presence as the wire says it. No folder = nothing to have
   *  destroyed, so active. */
  private static readonly status = sqlRaw<'active' | 'destroyed'>`case when ${folders.id} is null or ${folders.onDisk} then 'active' else 'destroyed' end`;
  /** A session with no folder has never touched a checkout: its birth is
   *  its last activity. */
  private static readonly lastUsedAt = sqlRaw<Date>`coalesce(${folders.lastUsedAt}, ${sessions.createdAt})`.mapWith((v) => new Date(v));
  private static readonly view = {
    ...sessionColumns, branch: folders.branch, status: Sessions.status, lastUsedAt: Sessions.lastUsedAt,
    lastPushAt: folders.lastPushAt, work: folders.work,
  };
  /** `select view from sessions left join folders` — every read starts here. */
  private from() {
    return this.db.select(Sessions.view).from(sessions).leftJoin(folders, eq(folders.id, sessions.folderId));
  }

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
    const cfg = await this.settings.resolveMany(['coding_provider', 'coding_model', 'coding_base_url',
      'supervisor_provider', 'supervisor_model', 'supervisor_base_url',
      'assistant_provider', 'assistant_model', 'assistant_base_url'], workspace ? { workspace } : {});
    if (agent) {
      try { return cascade(cfg, agent); } catch { /* nothing usable yet — the row stays empty */ }
    }
    return { provider: cfg.coding_provider ?? null, model: cfg.coding_model ?? null, baseUrl: cfg.coding_base_url ?? null };
  }

  /** A setting changed: every session with nothing said yet (and no turn in
   *  flight) takes the settings' model now. The row change goes out on the
   *  session feed, so a window showing that session repaints from it. */
  async followModelSettings(): Promise<void> {
    const rows = await this.from().where(eq(sessions.turnCount, 0));
    const now = Date.now();
    for (const s of rows) {
      if (isHeld(s, now)) continue;
      const m = await this.birthModel(s.workspaceId, s.agent as 'supervisor' | 'assistant' | null);
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
   *  one read that names the blob on purpose. */
  async transcript(id: string): Promise<string | null> {
    const rows = await this.db.select({ data: sessions.transcript }).from(sessions).where(eq(sessions.id, id));
    return rows[0]?.data ?? null;
  }

  /** The frozen system prompt, or null when the row has none (a
   *  conversation-only session, or one born before 025 and not yet opened).
   *  The other read that names a blob on purpose. */
  async systemPrompt(id: string): Promise<CodingPrompt | null> {
    const rows = await this.db.select({ prompt: sessions.systemPrompt }).from(sessions).where(eq(sessions.id, id));
    return rows[0]?.prompt ?? null;
  }

  /** Write the prompt once: only a row with none takes it, so a restart or a
   *  re-open can never move a running session's prompt. Returns what the row
   *  holds afterwards. */
  async freezeSystemPrompt(id: string, prompt: CodingPrompt): Promise<CodingPrompt> {
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
      .leftJoin(folders, eq(folders.id, sessions.folderId))
      .leftJoin(cards, eq(cards.id, sessions.cardId))
      .leftJoin(logTokens, eq(logTokens.sessionId, sessions.id))
      .where(and(...filters, ...(cursor ? [cursor] : [])))
      .groupBy(sessions.id, folders.id, cards.number, cards.status)
      .orderBy(desc(sessions.pinned), desc(Sessions.lastUsedAt), desc(sessions.id))
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

  /** The sessions that own files on disk — the disk sweeps' set: each is the
   *  session whose folder is its own and present. */
  async listOwnersOnDisk(): Promise<SessionRow[]> {
    return this.from().where(and(eq(folders.id, sessions.id), eq(folders.onDisk, true)));
  }

  // ── the card ───────────────────────────────────────────────────────────────────────
  // THE RULE: a session's card is its row's card_id. A card's coder is its
  // newest coding session; its supervisor is its newest supervisor session.
  // Nothing stores the pairing — it is read off the two newest rows. The
  // card is addressed by its number here, the handle the whole app uses;
  // the row holds the key.

  /** The newest session of `agent` kind on the card, any status — a
   *  destroyed coder is still the card's coder (the looper restarts it). */
  private async newestOnCard(workspaceId: string, cardNumber: number, kind: 'coding' | 'supervisor'):
  Promise<SessionRow | undefined> {
    const rows = await this.from()
      .innerJoin(cards, eq(cards.id, sessions.cardId))
      .where(and(eq(cards.workspace_id, workspaceId), eq(cards.number, cardNumber),
        kind === 'coding' ? isCodingSession : eq(sessions.agent, 'supervisor')))
      .orderBy(desc(sessions.createdAt)).limit(1);
    return rows[0];
  }

  /** The card's coding session — the one building it. */
  coderOf(workspaceId: string, cardNumber: number): Promise<SessionRow | undefined> {
    return this.newestOnCard(workspaceId, cardNumber, 'coding');
  }

  /** The card's supervisor session — the looper's verdict record. */
  supervisorOf(workspaceId: string, cardNumber: number): Promise<SessionRow | undefined> {
    return this.newestOnCard(workspaceId, cardNumber, 'supervisor');
  }

  /** Every card's coding session in a workspace — the newest per card, the
   *  same rule `coderOf` uses. One query for the whole board. */
  async codersByCard(workspaceId: string): Promise<Array<SessionRow & { card: number }>> {
    return this.db.selectDistinctOn([sessions.cardId], { ...Sessions.view, card: cards.number })
      .from(sessions)
      .leftJoin(folders, eq(folders.id, sessions.folderId))
      .innerJoin(cards, eq(cards.id, sessions.cardId))
      .where(and(eq(cards.workspace_id, workspaceId), isCodingSession))
      .orderBy(sessions.cardId, desc(sessions.createdAt));
  }

  /** Put the session on a card. The looper's write when it opens a round's
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

  /** Create a session: a conversation born with its own checkout
   *  (Folders.checkout), sharing the id. Passing `id` RESTARTS a session
   *  whose files were removed: the folder remembers the branch, so the same
   *  id comes back exactly where it stopped (Folders.restore). `fromBranch`
   *  cuts a NEW session's branch from a source branch on origin instead of
   *  base (the duplicate route). */
  async create(workspaceId: string, opts: { id?: string; fromBranch?: string } = {}): Promise<SessionFull> {
    const workspace = await this.workspaces.get(workspaceId);
    if (!workspace) throw new SessionError('not_found', `no workspace ${workspaceId}`);

    const prior = opts.id ? await this.get(opts.id) : undefined;
    if (prior && prior.workspaceId !== workspaceId) {
      throw new SessionError('workspace_mismatch', `session ${prior.id} belongs to another workspace`);
    }
    // A session that does not own its folder has no files of its own — there
    // is nothing to restart.
    if (prior && !ownsFolder(prior)) {
      throw new SessionError('invalid_args',
        'a supervisor session holds only its conversation — there are no files to restart; the looper creates these');
    }
    // Files still on disk: rebuilding them underneath would delete work that
    // has not been pushed yet.
    if (prior && prior.status === 'active') {
      throw new SessionError('already_active', `session ${prior.id} is still active`);
    }
    // A cut point belongs to a NEW session alone: a restart's start point is the
    // branch the folder remembers, never a second opinion.
    if (prior && opts.fromBranch) {
      throw new SessionError('invalid_args', 'fromBranch cuts a NEW session\'s branch — a restart has its own');
    }

    if (prior) {
      const folder = (await this.folders.get(prior.id))!;
      await this.folders.restore(folder, workspace);
      log.info({ session: prior.id, branch: folder.branch }, 'session restarted');
      const row = (await this.get(prior.id))!;
      return { ...row, branch: folder.branch, cutFromSha: folder.cutFromSha };
    }

    // The folder (the checkout) and the session (the conversation) are born
    // together, sharing the id.
    const id = opts.id ?? newId();
    const folder = await this.folders.checkout(workspace, id, { fromBranch: opts.fromBranch });
    await this.db.insert(sessions).values({ id, workspaceId, folderId: id, ...await this.birthModel(workspaceId) });
    const row = (await this.get(id))!;
    log.info({ session: id, branch: folder.branch }, 'session created');
    this.changed(id);
    return { ...row, branch: folder.branch, cutFromSha: folder.cutFromSha };
  }

  /** A conversation-only session: no checkout of its own — `folderId` points at
   *  another session's folder (the files it can read), or is null when there is
   *  nothing to read. The shared base for supervisor and assistant sessions. */
  private async createConversation(
    workspaceId: string, opts: { agent: 'supervisor' | 'assistant'; folderId?: string | null; cardId?: number },
  ): Promise<SessionRow> {
    const id = newId();
    await this.db.insert(sessions).values({
      id, workspaceId, agent: opts.agent,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(opts.cardId ? { cardId: opts.cardId } : {}),
      ...await this.birthModel(workspaceId, opts.agent),
    });
    this.changed(id);
    return (await this.get(id))!;
  }

  /** The supervisor's conversation-only session, on its coder's card: no
   *  folder of its own — its folder_id points at the coder's, which is where
   *  the files are. */
  createSupervisor(workspaceId: string, folderId: string, cardId: number): Promise<SessionRow> {
    return this.createConversation(workspaceId, { agent: 'supervisor', folderId, cardId });
  }

  /** Where the assistant's row points: the workspace, and the folder of the
   *  session on screen (that session's own folderId — a coder owns its
   *  folder, a supervisor borrows the coder's). No session on screen = the
   *  workspace alone, no folder. The same resolution for creating the row
   *  and re-pointing it. */
  private async assistantTarget(workspaceId: string, activeSessionId?: string | null) {
    const active = activeSessionId ? await this.get(activeSessionId) : undefined;
    return { workspaceId, folderId: active?.folderId ?? null };
  }

  /** The assistant's conversation-only session, pointed at what the user is
   *  looking at. */
  async createAssistant(workspaceId: string, activeSessionId?: string | null): Promise<SessionRow> {
    const t = await this.assistantTarget(workspaceId, activeSessionId);
    return this.createConversation(t.workspaceId, { agent: 'assistant', folderId: t.folderId });
  }

  /** The assistant's row follows the session on screen: its tools read that
   *  session's files, so its workspace and folder are re-pointed at it on
   *  every switch. Assistant rows only; a no-op when nothing moved. */
  async follow(id: string, workspaceId: string, activeSessionId?: string | null): Promise<void> {
    const s = await this.get(id);
    if (!s || s.agent !== 'assistant') return;
    const t = await this.assistantTarget(workspaceId, activeSessionId);
    if (s.workspaceId === t.workspaceId && s.folderId === t.folderId) return;
    await this.db.update(sessions).set(t).where(eq(sessions.id, id));
    this.changed(id);
  }

  /** What travels from a source into its freshly created copy (the duplicate
   *  route): the conversation minus its usage lines, the preview, the name,
   *  plan mode, the frozen PROMPT and the MODEL — the copy runs on what the
   *  source ran on, and can be moved with /model or a preset until its first
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
        transcript: stripUsageFromJsonl(data),
        lastUserMessage: src.lastUserMessage, name: src.name, nameManual: src.nameManual,
        transcriptUpdatedAt: stamp,
      } : {}),
    }).where(eq(sessions.id, copy.id));
    this.changed(copy.id);
  }

  /** Explicit delete honors the request even when work would be lost — that is
   *  the caller's decision to make. The automatic sweep (disk.ts) never does.
   *  Deletes the session's FILES and nothing else (Folders.removeFiles) — the
   *  folder keeps the branch, so `create` with the same id restarts it where
   *  it stopped. Only a session that owns its folder has files; a caller
   *  checks `ownsFolder`. */
  async destroy(session: SessionRow, opts: { force: boolean }): Promise<void> {
    if (!ownsFolder(session)) throw new SessionError('no_files', `session ${session.id} has no files of its own`);
    await this.folders.removeFiles((await this.folders.get(session.id))!, opts);
    log.info({ session: session.id }, 'session destroyed');
  }

  /** The row goes for good, the transcript on it. Only its pushed branch on
   *  origin survives. Files first (`destroy`). */
  async purge(id: string): Promise<void> {
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
    // Token totals are per-call entries in log_tokens — the list
    // query JOINs that table directly. No re-parsing, no row cache.
    // Every save is one turn: the counter that paces session naming.
    const agent = agentAfterSave(s.agent, client);
    const [saved] = await this.db.update(sessions)
      .set({ transcript: data, lastUserMessage, transcriptUpdatedAt: stamp,
        turnCount: sqlRaw`${sessions.turnCount} + 1`, agent })
      .where(eq(sessions.id, s.id))
      .returning({ name: sessions.name, turnCount: sessions.turnCount, nameManual: sessions.nameManual });
    // Saving a turn is activity on the checkout: it stays off the idle sweep.
    if (s.folderId) await this.folders.touch(s.folderId);
    // The record landed: the one moment a client can trust that the server's
    // copy moved. Watchers pull the transcript on this. `by` is the writer,
    // so the window that just uploaded its OWN turn ignores the echo instead
    // of re-pulling and repainting the reply it already drew.
    this.events?.publish(s.id, client, { event: 'transcript', updated_at: stamp.toISOString(), by: client });
    if (agent !== s.agent) this.events?.publish(s.id, client, { event: 'session', agent });
    return { stamp, agent, name: saved.name, turnCount: saved.turnCount, nameManual: saved.nameManual };
  }

  /** Step-level save: updates ONLY the transcript text and touches the
   *  checkout. No turn count bump, no naming, no transcript event. The
   *  lightweight per-step counterpart to saveTranscript. */
  async stepSave(s: SessionRow, data: string): Promise<Date> {
    const stamp = new Date();
    await this.db.update(sessions)
      .set({ transcript: data, transcriptUpdatedAt: stamp })
      .where(eq(sessions.id, s.id));
    if (s.folderId) await this.folders.touch(s.folderId);
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

  /** A turn ended on a conversation-only session (the assistant's): bump the
   *  turn count (leaving 0 is what freezes the row's model) and touch its
   *  checkout. Tokens are not here — every model call records its own row
   *  in log_tokens. */
  async turnEnded(s: SessionRow): Promise<void> {
    await this.db.update(sessions).set({ turnCount: sqlRaw`${sessions.turnCount} + 1` }).where(eq(sessions.id, s.id));
    if (s.folderId) await this.folders.touch(s.folderId);
    this.changed(s.id);
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

  /** The idle digest mentioned this session. */
  async markDigested(id: string, at: Date): Promise<void> {
    await this.db.update(sessions).set({ digestNotifiedAt: at }).where(eq(sessions.id, id));
  }

  /** A tool call on the session: its CHECKOUT was used, whoever's session
   *  it is — a supervisor's read keeps the coder's container warm the same
   *  as the coder's own. Background jobs never touch, or nothing goes cold. */
  async touch(s: SessionRow): Promise<void> {
    if (s.folderId) await this.folders.touch(s.folderId);
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
