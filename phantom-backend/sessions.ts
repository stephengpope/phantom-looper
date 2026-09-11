// Session lifecycle. A session binds to a workspace and a directory at creation
// and never changes; the id names the directory and the branch.
//
// ONE branch, start to finish: it is checked out at creation, worked in,
// committed to, and pushed back to. Nothing is ever pushed anywhere else. The
// branch is always the session's own {prefix}/{id}, cut from the base branch,
// and is recorded on the row, so it is decided once and never re-derived.
import fs from 'node:fs/promises';
import { and, desc, eq, isNull, lt, or, sql as sqlRaw } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { workspaces, sessions, sessionColumns, folders, loops, type WorkspaceRow, type SessionRow, type FolderRow, type LoopRow } from './db/schema.js';
import { resolve } from './settings.js';
import { git, cloneFresh, checkoutBranch, classifyGitFailure, localState } from './git/git.js';
import { claimSlot, resolveAuth } from './pool/pool.js';
import { sessionDir, repoDir, type Paths } from './pool/paths.js';
import { newId } from '../core/ids.js';
import { logger, errStr } from './log.js';

const log = logger('sessions');

export class SessionError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

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
export async function createSession(
  db: Db, p: Paths, encryptionKey: Buffer, workspaceId: string, opts: { id?: string; fromBranch?: string } = {},
): Promise<SessionFull> {
  const workspaceRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspaceRows.length) throw new SessionError('not_found', `no workspace ${workspaceId}`);
  const workspace = workspaceRows[0];

  const prior = opts.id
    ? (await db.select(sessionColumns).from(sessions).where(eq(sessions.id, opts.id)))[0]
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
  const dest = sessionDir(p, id);
  const dir = repoDir(p, id);
  const auth = await resolveAuth(db, workspace, encryptionKey);
  // A restart uses the branch the FOLDER remembers — the work is on it. The
  // folder shares the session's id, so directories keep their names.
  const priorFolder = prior?.folderId
    ? (await db.select().from(folders).where(eq(folders.id, prior.folderId)))[0]
    : undefined;
  const branch = priorFolder?.branch ?? `${workspace.branchPrefix}/${id}`;

  // Everything from here to the checkout talks to the remote, and a remote
  // failure has a MEANING a person can act on — a dead token, a repo the token
  // cannot see, GitHub unreachable. Classified into a SessionError so the API
  // answers with that meaning; anything unrecognised keeps its own error.
  let found: 'existing' | 'new';
  let claimSha: string;
  let claimed: boolean;
  try {
    claimed = await claimSlot(p, workspace.owner, workspace.name, workspace.baseBranch, dest);
    if (claimed) {
      // Pool slots are pristine by construction, so the unguarded catch-up is
      // safe — and mandatory: a slot stocked days ago is days behind.
      await git(dir, ['fetch', 'origin', workspace.baseBranch], auth);
      await git(dir, ['reset', '--hard', `origin/${workspace.baseBranch}`]);
    } else {
      const depth = await resolve(db, 'initial_history_depth', { workspace });
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
    await db.update(sessions).set({ status: 'active', lastUsedAt: new Date() })
      .where(eq(sessions.id, prior.id));
    log.info({ session: id, branch, found }, 'session restarted');
    const row = (await db.select(sessionColumns).from(sessions).where(eq(sessions.id, prior.id)))[0];
    return { ...row, branch, claimSha: priorFolder?.claimSha ?? claimSha };
  }

  // The folder (the checkout's identity: branch + claim) and the session (the
  // conversation) are born together, sharing the id.
  await db.insert(folders).values({ id, workspaceId, branch, claimSha, createdAt: new Date() });
  await db.insert(sessions).values({ id, workspaceId, status: 'active', folderId: id });
  const row = (await db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)))[0];
  log.info({ session: id, workspace: `${workspace.owner}/${workspace.name}`, branch, found, claimed, claimSha },
    'session created');
  return { ...row, branch, claimSha };
}

/** A session with its folder's facts joined in — what the API serves, so
 *  clients keep seeing `branch` even though sessions no longer carry it. */
export type SessionFull = SessionRow & { branch: string; claimSha: string };

export async function getFolder(db: Db, id: string): Promise<FolderRow | undefined> {
  const rows = await db.select().from(folders).where(eq(folders.id, id));
  return rows[0];
}

export async function getSession(db: Db, id: string): Promise<SessionRow | undefined> {
  const rows = await db.select(sessionColumns).from(sessions).where(eq(sessions.id, id));
  return rows[0];
}

/** Tool calls count as use; background jobs do not, or nothing ever goes cold. */
export async function touchSession(db: Db, id: string): Promise<void> {
  await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, id));
}

/** Add a turn's token usage to a session's running totals. Incremental — each
 *  call adds to the existing sums, so turns update the row without re-reading
 *  the whole transcript. Also touches lastUsedAt and pins the model on the
 *  first call (same rule as the coding transcript save). */
export async function addSessionUsage(
  db: Db, id: string, usage: { input: number; output: number; cache_read: number; cache_write: number },
  model?: { provider: string; model: string; baseUrl?: string | null },
): Promise<void> {
  const stamp = new Date();
  const s = await getSession(db, id);
  if (!s) return;
  const pinning = s.provider == null && s.model == null && model;
  await db.update(sessions).set({
    tokensInput: (s.tokensInput ?? 0) + usage.input,
    tokensOutput: (s.tokensOutput ?? 0) + usage.output,
    tokensCacheRead: (s.tokensCacheRead ?? 0) + usage.cache_read,
    tokensCacheWrite: (s.tokensCacheWrite ?? 0) + usage.cache_write,
    tokensAsOf: stamp,
    lastUsedAt: stamp,
    turnCount: sqlRaw`${sessions.turnCount} + 1`,
    ...(pinning ? { provider: model.provider, model: model.model, baseUrl: model.baseUrl } : {}),
  }).where(eq(sessions.id, id));
}

/** Move a conversation-only session's workspace and folder pointers — the
 *  assistant's session follows what the user is looking at. */
export async function updateSessionPointers(
  db: Db, id: string, patch: { workspaceId?: string; folderId?: string | null },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.workspaceId !== undefined) set.workspaceId = patch.workspaceId;
  if (patch.folderId !== undefined) set.folderId = patch.folderId;
  if (Object.keys(set).length) await db.update(sessions).set(set).where(eq(sessions.id, id));
}

/** Explicit delete honors the request even when work would be lost — that is
 *  the caller's decision to make. The automatic sweep below never does. */
export async function destroySession(
  db: Db, p: Paths, session: SessionRow, opts: { force: boolean },
): Promise<void> {
  // A session that does not OWN its folder (the supervisor's, an orphan) has
  // no files of its own: mark it and stop.
  if (session.folderId !== session.id) {
    await db.update(sessions).set({ status: 'destroyed' }).where(eq(sessions.id, session.id));
    log.info({ session: session.id }, 'conversation-only session destroyed (no files)');
    return;
  }
  const folder = await getFolder(db, session.folderId);
  const dir = repoDir(p, session.id);
  const state = folder
    ? await localState(dir, folder.branch).catch(() => 'unknown' as const)
    : 'clean' as const;
  if (state !== 'clean' && !opts.force) {
    log.warn({ session: session.id, state }, 'destroy would discard work — refusing (pass force)');
    throw new SessionError('unpushed_work', `session holds ${state} work; delete with force=true to discard`);
  }
  await fs.rm(sessionDir(p, session.id), { recursive: true, force: true });
  await db.update(sessions).set({ status: 'destroyed' }).where(eq(sessions.id, session.id));
  log.info({ session: session.id, state }, 'session destroyed');
}

/** Idle sessions keep their files until the disk needs them back: the
 *  pressure sweep (disk.ts) is the ONE deleter, and it backs up first. */

// ── The session's OWN rules — one owner, everything else calls in ───────────
// Locks, the loop's stamps, and the conversation-only special case all live
// HERE. No route, no engine, no trigger touches the sessions table directly.

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

/** Take (or renew) the hold for `client`. One conditional UPDATE — free,
 *  expired, or already mine — so two clients racing cannot both win.
 *  Returns the expiry, or null when someone else holds it. */
export async function acquireLock(
  db: Db, s: SessionRow, client: string, ttlMs: number, label?: string,
): Promise<Date | null> {
  const expires = new Date(Date.now() + ttlMs);
  const rows = await db.update(sessions)
    .set({ lockedBy: client, lockExpiresAt: expires,
      ...(label !== undefined ? { lockedLabel: label } : {}) })
    .where(and(eq(sessions.id, s.id),
      or(isNull(sessions.lockedBy), eq(sessions.lockedBy, client),
        isNull(sessions.lockExpiresAt), lt(sessions.lockExpiresAt, new Date()))))
    .returning({ id: sessions.id });
  return rows.length ? expires : null;
}

/** Release `client`'s hold. Idempotent — releasing what you do not hold
 *  changes nothing. Returns whether anything was released. */
export async function releaseLock(db: Db, id: string, client: string): Promise<boolean> {
  const rows = await db.update(sessions)
    .set({ lockedBy: null, lockedLabel: null, lockExpiresAt: null })
    .where(and(eq(sessions.id, id), eq(sessions.lockedBy, client)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Slide the holder's expiry forward (a save renews the hold). */
/** A turn began on the session with `message` — the moment the list's
 *  preview can move (the save at turn end used to be the first chance) and,
 *  on a session's FIRST message, the moment to name it. Says whether it is
 *  that first message: unnamed, never a turn saved, not a loop seat (a loop
 *  session's first message is the loop's fixed kickoff text, which would
 *  name every card's session after the kickoff; those are named off the
 *  save, where the reply is in). Manual names are never in play here — a
 *  renamed session is never unnamed. */
export async function turnStarted(db: Db, id: string, message: string): Promise<{ firstMessage: boolean }> {
  const rows = await db.update(sessions)
    .set({ lastUserMessage: message.slice(0, LAST_MESSAGE_CHARS) })
    .where(eq(sessions.id, id))
    .returning({ name: sessions.name, turnCount: sessions.turnCount, agent: sessions.agent });
  const r = rows[0];
  return { firstMessage: !!r && r.name === null && r.turnCount === 0 && r.agent === null };
}

/** The list's preview of the last thing the user typed: a few dozen
 *  characters on screen, so this many stored — never the record. */
export const LAST_MESSAGE_CHARS = 200;

export async function renewLock(db: Db, id: string, client: string, ttlMs: number): Promise<Date> {
  const expires = new Date(Date.now() + ttlMs);
  await db.update(sessions).set({ lockExpiresAt: expires })
    .where(and(eq(sessions.id, id), eq(sessions.lockedBy, client)));
  return expires;
}

// ── The loop's operations — the ONLY writers of loops; agent's two writers ──

/** The looper's client id — the one holder whose saves are the loop's own
 *  turns. The engine locks with it, the release hook ignores it, and the
 *  transcript save reads who drove the turn off it. */
export const LOOP_CLIENT_ID = 'supervisor';

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

/** The current loop for a card: the newest row. Old rows are history. */
export async function currentLoop(db: Db, workspaceId: string, card: number): Promise<LoopRow | undefined> {
  const rows = await db.select().from(loops)
    .where(and(eq(loops.workspaceId, workspaceId), eq(loops.card, card)))
    .orderBy(desc(loops.createdAt)).limit(1);
  return rows[0];
}

/** The card a coding session is building, as one line for the auto-push commit
 *  message: "title — description". A diff says what changed and never why, and
 *  this is the cheapest statement of why the system already holds.
 *
 *  Fails open to '' — a manual session has no loop row, a workspace schema can
 *  be missing, and NONE of that may stop work from landing. The commit message
 *  simply loses its intent line (fill drops the line whole when it is empty). */
export async function cardIntentFor(
  db: Db, session: SessionRow, workspace: WorkspaceRow,
): Promise<string> {
  try {
    const rows = await db.select().from(loops)
      .where(and(eq(loops.workspaceId, session.workspaceId), eq(loops.codingSessionId, session.id)))
      .orderBy(desc(loops.createdAt)).limit(1);
    const seq: number | undefined = rows[0]?.card;
    if (seq === undefined) return session.name ?? '';
    const r = await db.execute(
      sqlRaw.raw(`select title, description from "${workspace.schemaName}".cards where seq = ${Number(seq)}`));
    const card = (r as unknown as { rows: { title?: string; description?: string }[] }).rows?.[0];
    if (!card?.title) return session.name ?? '';
    const firstLine = (card.description ?? '').trim().split('\n')[0] ?? '';
    return firstLine ? `${card.title} — ${firstLine}` : card.title;
  } catch (e) {
    log.debug({ session: session.id, err: errStr(e) }, 'card intent unavailable — commit message goes without it');
    return session.name ?? '';
  }
}

/** Tag a conversation with who drives it. The loop stamps its coder seat at
 *  every turn START (so the row is right while the turn runs); the transcript
 *  save re-derives it from the writer at turn END (agentAfterSave). */
export async function stampAgent(db: Db, id: string, agent: 'coding' | 'supervisor'): Promise<void> {
  await db.update(sessions).set({ agent }).where(eq(sessions.id, id));
}

/** A conversation-only session: no checkout of its own — `folderId` points at
 *  another session's folder (the files it can read), or is null when there is
 *  nothing to read. The shared base for supervisor and assistant sessions. */
export async function createConversationSession(
  db: Db, workspaceId: string,
  opts: { agent: 'supervisor' | 'assistant'; folderId?: string | null },
): Promise<SessionRow> {
  const id = newId();
  await db.insert(sessions).values({
    id, workspaceId, status: 'active', agent: opts.agent,
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
  });
  return (await db.select(sessionColumns).from(sessions).where(eq(sessions.id, id)))[0];
}

/** The supervisor's conversation-only session: no folder of its own — its
 *  folder_id points at the coder's, which is where the files are. */
export async function createSupervisorSession(
  db: Db, workspaceId: string, folderId: string,
): Promise<SessionRow> {
  return createConversationSession(db, workspaceId, { agent: 'supervisor', folderId });
}

/** The assistant's conversation-only session: workspace and folder track
 *  whatever the user is looking at, updated as they switch. */
export async function createAssistantSession(
  db: Db, workspaceId: string, folderId?: string | null,
): Promise<SessionRow> {
  return createConversationSession(db, workspaceId, { agent: 'assistant', folderId });
}

/** Name a still-unnamed session. The loop's coder seat takes its CARD's
 *  title the moment the pair is written — deterministic, instant, no model
 *  call; the card title stays authoritative while set. A name already there
 *  (a person's /rename included) stands. */
export async function nameIfUnnamed(db: Db, id: string, name: string): Promise<void> {
  await db.update(sessions).set({ name }).where(and(eq(sessions.id, id), isNull(sessions.name)));
}

/** The pairing, written ONCE when a card enters the loop. Immutable — this
 *  row is the permanent record of who reviews what. */
export async function createLoop(
  db: Db, workspaceId: string, card: number, codingSessionId: string, supervisorSessionId: string,
): Promise<LoopRow> {
  const id = newId();
  await db.insert(loops).values({ id, workspaceId, card, codingSessionId, supervisorSessionId });
  return (await db.select().from(loops).where(eq(loops.id, id)))[0];
}

/** Which card a session belongs to, if any — via its loop, either seat. */
export async function loopOf(db: Db, sessionId: string): Promise<LoopRow | undefined> {
  const rows = await db.select().from(loops)
    .where(or(eq(loops.codingSessionId, sessionId), eq(loops.supervisorSessionId, sessionId)))
    .orderBy(desc(loops.createdAt)).limit(1);
  return rows[0];
}
