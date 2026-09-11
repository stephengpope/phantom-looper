import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { eq, ne, desc, and, or, isNull, isNotNull, lt, sql, count, inArray } from 'drizzle-orm';
import { sessions, sessionColumns, workspaces, folders, loops, settings as settingsRows, type SessionRow } from '../../db/schema.js';
import { createSession, getSession, getFolder, destroySession, touchSession, SessionError,
  heldByOther, acquireLock, releaseLock, renewLock, assertDuplicable, conversationOnly, agentAfterSave,
  turnStarted, LAST_MESSAGE_CHARS, createAssistantSession, addSessionUsage } from '../../sessions.js';
import { GIT_CLIENT_ID } from '../../git/git.js';
import { repoDir, sessionDir } from '../../pool/paths.js';

import { scanSkills, mergeSkills } from '../../../core/skills/skills.js';
import { systemSkills } from '../../systemSkills.js';
import { environmentFacts } from '../../environment.js';
import { lastUserFromJsonl, headerModelFromJsonl, sumUsageFromJsonl, stripUsageFromJsonl } from '../../../core/llm/transcript.js';
import { resolve, resolveMany, settingsBlock } from '../../settings.js';
import { sessionScope, listSecrets, GLOBAL, workspaceScope } from '../../store.js';
import { ok, err, type AppCtx } from '../app.js';
import { openSession, SessionLockedError } from '../../../core/session.js';
import { injectFetch } from '../../looper/injectFetch.js';
import { runCodingTurn } from '../../looper/turn.js';
import { writeAttachment } from '../../telegram/attachments.js';
import type { SessionEvent } from '../sessionEvents.js';

const log = logger('sessions');

/** The session's hold as a feed record — what a watcher's spinner reads.
 *  From the row when the feed opens (`s`), or from the write that just
 *  happened (the overrides). An expired hold reads as free. */
function lockEvent(s: SessionRow, over: Partial<{ locked: boolean; by: string | null; label: string | null;
  expires: Date | null }> = {}): SessionEvent {
  const expires = over.expires !== undefined ? over.expires : s.lockExpiresAt ?? null;
  const locked = over.locked ?? (!!s.lockedBy && !!expires && expires.getTime() > Date.now());
  return { event: 'lock', locked,
    by: locked ? (over.by !== undefined ? over.by : s.lockedBy) : null,
    label: locked ? (over.label !== undefined ? over.label : s.lockedLabel) : null,
    agent: s.agent ?? null,
    expires_at: locked && expires ? expires.toISOString() : null };
}
import { shouldName, nameSession, titleContext, firstMessageContext } from '../../sessionTitle.js';
import { logger, errStr } from '../../log.js';

const TAG = { tags: ['sessions'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

/** An attached file's ceiling (attachments route) — ours, unlike telegram's
 *  20MB bot-API ceiling: a screencast should fit, a disk image should not. */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;



// The session lock rides the x-phantom-looper-client header: an opaque id the client
// invents for itself (the TUI mints one per window). Never in a body — the
// same rule as the session header.
const clientOf = (req: FastifyRequest): string => {
  const h = req.headers['x-phantom-looper-client'];
  return typeof h === 'string' ? h : '';
};

const lockedErr = (s: SessionRow) =>
  err('session_locked', `session is in use${s.lockedLabel ? ` on ${s.lockedLabel}` : ''} — release it there, or wait for the hold to expire`, true);

/** The first line of a transcript is its header; a duplicate keeps the frozen
 *  system prompt but is a different session on a different branch, so those
 *  two fields are rewritten — and the model fields are DROPPED (a key patched
 *  to undefined serializes away), because the copy is born unpinned: it
 *  follows /model and presets until its first new message, exactly like a
 *  fresh session — because its ROW carries no pin, which is the only place a
 *  pin lives. The header travels WHOLE: it records what the source ran, and
 *  the copy's first message rewrites it to what the copy ran. An unparsable
 *  first line is left alone — the loader skips what it cannot parse, same as
 *  everywhere. */
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

/** Look up the card linked to a session via the loops table, then publish a
 *  board lock event so the kanban board can show/hide the spinner. Fire-and-
 *  forget: a failed lookup never blocks the lock route. */
async function publishBoardLock(ctx: AppCtx, sessionId: string, locked: boolean): Promise<void> {
  try {
    const [row] = await ctx.db.select({ card: loops.card, workspaceId: loops.workspaceId })
      .from(loops).where(eq(loops.codingSessionId, sessionId))
      .orderBy(desc(loops.createdAt)).limit(1);
    if (row) ctx.events?.publish(row.workspaceId,
      { event: 'session_lock', card: row.card, id: sessionId, locked });
  } catch { /* best-effort — the board refreshes on reconnect anyway */ }
}

export function sessionRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.post<{ Body: { workspace_id: string; id?: string } }>('/sessions', { schema: { ...TAG,
    summary: 'Create — or restart — a session',
    description: 'Claims a pre-cloned pool directory (or clones) and checks out the session\'s branch: ' +
      'its own {prefix}/{id}, cut from the base branch. That one branch ' +
      'is worked in and pushed back to; nothing is pushed anywhere else. The returned id goes in the ' +
      'x-phantom-looper-session header on every tool call.\n\n' +
      'Pass `id` to RESTART a session that was destroyed. Destroying a session deletes its files and ' +
      'nothing else — the row keeps its id and its branch — so a restart re-clones, finds that branch on ' +
      'origin, and carries on exactly where it stopped. Restarting a session that is still active is refused.\n\n' +
      'The response carries `skills` — the repo\'s .agents/skills/ (scanned from the session\'s branch ' +
      'AFTER checkout) merged with the workspace image\'s baked /opt/skills, repo shadowing system — so a ' +
      'client can put them in the agent\'s system prompt before its first turn. GET /skills is the live view.\n\n' +
      'It also carries `agent_git_credentials` — the workspace\'s resolved value at ' +
      'creation — so a client can state that fact in the same frozen prompt.',
    body: { type: 'object', required: ['workspace_id'], additionalProperties: false,
      examples: [{ workspace_id: 'paste the id from POST /workspaces' }],
      properties: {
        workspace_id: { type: 'string' },
        id: { type: 'string', description: 'Restart this session id instead of starting a new one.' },
      } } } }, async (req, reply) => {
    if (!req.body?.workspace_id) return reply.code(400).send(err('missing_workspace', 'body.workspace_id required'));
    try {
      const s = await createSession(ctx.db, ctx.paths, ctx.encryptionKey, req.body.workspace_id,
        { id: req.body.id });
      const wsRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
      const workspace = wsRows[0];
      // Two tiers, merged here so every client (cli, looper) freezes the same
      // list: the repo's — scanned AFTER createSession returns, when the
      // checkout is on the SESSION's branch (a claim sits on base until
      // checkoutBranch; scanning at claim would read the wrong branch, worst
      // on restart) — and the image's system tier, repo shadowing system.
      const creation = await resolveMany(ctx.db, ['container_image', 'agent_git_credentials'], { workspace });
      const image = creation.container_image;
      const skills = mergeSkills(
        await scanSkills(repoDir(ctx.paths, s.id)),
        ctx.fs ? await systemSkills(ctx.fs.docker, String(image)) : []);
      // The workspace fact a client states in the frozen prompt: resolved
      // NOW (default -> override -> workspace), same name as the setting.
      const agent_git_credentials = creation.agent_git_credentials;
      // The secrets index, frozen the same way as skills: names +
      // descriptions only, global + this workspace, workspace shadowing
      // global by name. secret_list is the live view.
      const byName = new Map<string, { name: string; description: string }>();
      for (const sec of await listSecrets(ctx.db, [GLOBAL, workspaceScope(s.workspaceId)])) {
        if (sec.scope === GLOBAL && byName.has(sec.name)) continue;
        byName.set(sec.name, { name: sec.name, description: sec.description });
      }
      const secrets = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
      // The environment facts line, probed from the session image (cached by
      // image ID) — the dynamic half of the prompt's environment block.
      const environment = ctx.fs ? await environmentFacts(ctx.fs.docker, String(image)) : '';
      return reply.code(201).send(ok({ ...s, skills, secrets, environment, agent_git_credentials }));
    } catch (e) {
      if (e instanceof SessionError) {
        const status = e.code === 'already_active' ? 409
          : e.code === 'workspace_mismatch' || e.code === 'invalid_args'
            || e.code === 'credential_invalid' || e.code === 'credential_insufficient' ? 400
          : e.code === 'upstream_unreachable' ? 502 : 404;
        return reply.code(status).send(err(e.code, e.message, e.retryable));
      }
      throw e;
    }
  });

  // Listing exists for clients that need to show what is open — the TUI
  // launcher, above all. No filters: a deployment has a handful of sessions,
  // and the launcher wants the ended ones too so it can grey them out rather
  // than infer their fate from whether a local transcript happens to exist.
  app.get<{ Querystring: { limit?: number; before?: string; before_id?: string; before_pinned?: boolean; git?: string;
    typed?: boolean; supervisor?: boolean } }>(
    '/sessions', { schema: { ...TAG,
    summary: 'List sessions',
    description: 'Every session, pinned first then newest activity first, including destroyed ones (status says which). ' +
      'Each row carries `locked` (someone holds it right now, label in locked_label/locked_by), ' +
      '`lastUserMessage` (the last thing the user typed, from the server-side transcript) and ' +
      '`name` (a model-written title of what the session is building, best-effort). ' +
      'Join against GET /workspaces for names.\n\n' +
      'No parameters = the whole list. `limit` returns one page; the next page passes the last ' +
      'row\'s last_used_at as `before` and its id as `before_id` (the tie-break — several rows can ' +
      'share a timestamp). A page shorter than `limit` is the end. The cursor is the values the ' +
      'client SAW, so a session used since simply moves to the top of a later refresh — pages ' +
      'never repeat a row.\n\n' +
      '`git=true` adds `work` per row — where the session\'s work stands: not_pushed (only on ' +
      'this server\'s disk), not_merged (on origin\'s branch, not in base), merged (in base), or ' +
      'null (nothing to measure: no checkout, or not this session\'s own). Read from each ' +
      'checkout on disk — real work per row, so ask only when a screen will show it.',
    querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size; omitted = everything.' },
      typed: { type: 'boolean', description: 'true = only sessions something was typed into (a last message exists).' },
      supervisor: { type: 'boolean', description: 'false = leave out the looper\'s supervisor seats.' },
      before: { type: 'string', description: 'A row\'s last_used_at (ISO) — return only older activity.' },
      before_id: { type: 'string', description: 'That row\'s id, breaking last_used_at ties.' },
      before_pinned: { type: 'boolean', description: 'That row\'s pinned flag — pinned sorts ahead of activity, so the cursor carries it or a pinned page boundary leaks unpinned rows into the pinned block (and vice versa).' },
      git: { type: 'string', enum: ['true'], description: 'Compute `work` per row from the checkout.' } } } } },
  async (req) => {
    // last_user_message rides the list; the transcript blob NEVER does —
    // sessionColumns leaves it out, which is what keeps this list cheap.
    // branch comes from the session's FOLDER, card from its LOOP (either
    // seat) — sessions carry neither themselves.
    const { limit, before, before_id: beforeId, before_pinned: beforePinned } = req.query;
    const cut = before ? new Date(before) : undefined;
    // What the list IS is decided here, once — the filters and the count
    // share one WHERE, so `total` is exactly the rows the pages add up to.
    // The cli used to drop never-typed and supervisor rows itself, which left
    // every page half empty on screen and made its "more" count a guess.
    const filters = [];
    if (req.query.typed === true) filters.push(isNotNull(sessions.lastUserMessage));
    if (req.query.supervisor === false) filters.push(or(isNull(sessions.agent), ne(sessions.agent, 'supervisor')));
    // Assistant sessions are tracked for tokens, not for the session list —
    // always excluded from the list the user sees.
    filters.push(or(isNull(sessions.agent), ne(sessions.agent, 'assistant')));
    let q = ctx.db
      .select({ ...sessionColumns, branch: folders.branch, card: loops.card })
      .from(sessions)
      .leftJoin(folders, eq(folders.id, sessions.folderId))
      .leftJoin(loops, or(eq(loops.codingSessionId, sessions.id), eq(loops.supervisorSessionId, sessions.id)))
      // Pinned rows sit ahead of all activity ordering (018). id descends
      // too: a page boundary between rows sharing a timestamp must cut the
      // same way every time or the next page skips or repeats.
      .orderBy(desc(sessions.pinned), desc(sessions.lastUsedAt), desc(sessions.id))
      .$dynamic();
    // The cursor is the whole sort key of the last row the client saw:
    // pinned first (a pinned tail means only unpinned rows follow), then
    // the (last_used_at, id) pair as ever.
    const cursor = cut && !isNaN(cut.getTime())
      ? or(
        beforePinned === true ? eq(sessions.pinned, false) : undefined,
        and(eq(sessions.pinned, beforePinned === true),
          beforeId
            ? or(lt(sessions.lastUsedAt, cut), and(eq(sessions.lastUsedAt, cut), lt(sessions.id, beforeId)))
            : lt(sessions.lastUsedAt, cut)))
      : undefined;
    if (filters.length || cursor) q = q.where(and(...filters, ...(cursor ? [cursor] : [])));
    if (limit) q = q.limit(limit);
    const [rows, [{ total }]] = await Promise.all([
      q,
      ctx.db.select({ total: count() }).from(sessions).where(filters.length ? and(...filters) : undefined),
    ]);
    const now = Date.now();
    // Card status: the card's column on the board. Cards live in per-workspace
    // schemas, so one raw query per workspace that has cards in this page.
    // Keyed by `workspaceId:card` for the map below.
    const cardStatusMap = new Map<string, string>();
    const byWs = new Map<string, number[]>();
    for (const r of rows) {
      if (r.card == null) continue;
      const arr = byWs.get(r.workspaceId);
      if (arr) arr.push(r.card); else byWs.set(r.workspaceId, [r.card]);
    }
    if (byWs.size) {
      const wsRows = await ctx.db.select({ id: workspaces.id, schemaName: workspaces.schemaName })
        .from(workspaces).where(inArray(workspaces.id, [...byWs.keys()]));
      const schemaOf = new Map(wsRows.map((w) => [w.id, w.schemaName]));
      await Promise.all([...byWs.entries()].map(async ([wsId, cards]) => {
        const schema = schemaOf.get(wsId);
        if (!schema) return;
        const { rows: cardRows } = await ctx.pgPool.query(
          `select seq, status from "${schema}".cards where seq = any($1::int[])`, [cards]);
        for (const c of cardRows) cardStatusMap.set(`${wsId}:${c.seq}`, c.status);
      }));
    }
    // `work` is a stored column on the session row, updated by the server's
    // periodic git-state refresh (workRefresh.ts). It rides every response
    // in the ...r spread — no on-read computation, no git=true flag.
    // `locked` is computed HERE so no client has to compare clocks with the
    // server; a client only compares locked_by with its own id.
    return ok({ total, sessions: rows.map((r) => ({
      ...r, locked: !!r.lockedBy && !!r.lockExpiresAt && r.lockExpiresAt.getTime() > now,
      cardStatus: r.card != null ? (cardStatusMap.get(`${r.workspaceId}:${r.card}`) ?? null) : null,
    })) });
  });

  // ---- the session lock ----------------------------------------------------
  // One holder per session, named by the x-phantom-looper-client header. Acquire and
  // renew are the same call; there is no takeover — a hold ends by release or
  // by expiry (session_lock_ttl_ms). Duplicating forks a session, but it too
  // takes this lock first: its flush commits the tree, and a live writer
  // mid-turn must not be committed half-written.
  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    '/sessions/:id/lock', { schema: { ...TAG,
      summary: 'Hold a session',
      description: 'Claims the session for the client named in x-phantom-looper-client (an opaque id the client invents). ' +
        'While held, no other client may read or write the transcript. Calling again renews the hold; ' +
        'it also expires on its own after session_lock_ttl_ms without renewal. 409 while someone else holds it — ' +
        'there is no takeover: release it there, or wait for the hold to expire.',
      params: idParam,
      body: { type: 'object', additionalProperties: false, properties: {
        label: { type: 'string', maxLength: 200, description: 'What to show others (a hostname).' } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      // A running server turn is the truth the clock is not. `activeTurns`
      // holds the live turn's abort controller IN THIS PROCESS, so it cannot
      // outlive the work the way a hold in SQL can — kill the process and the
      // map and the turns die together. A lapsed TTL must therefore never hand
      // the session to a second writer while the first is still streaming:
      // that is two conversations on one transcript, and the last save wins.
      // The holder itself still renews normally.
      if (ctx.activeTurns?.has(s.id) && s.lockedBy && s.lockedBy !== client) {
        return reply.code(409).send(lockedErr(s));
      }
      const ttl = await resolve(ctx.db, 'session_lock_ttl_ms');
      const expires = await acquireLock(ctx.db, s, client, Number(ttl), req.body?.label);
      if (!expires) return reply.code(409).send(lockedErr(s));
      ctx.sessionEvents?.publish(s.id, client, lockEvent(s, { locked: true, by: client,
        label: req.body?.label ?? s.lockedLabel ?? null, expires }));
      // Notify the board when a session transitions from unlocked to locked
      // (not on renewals — those fire on every transcript save). The pre-
      // acquire row `s` tells us: same client = renewal, anything else = fresh.
      if (s.lockedBy !== client) void publishBoardLock(ctx, s.id, true);
      // The transcript's stamp rides along so a turn can tell whether its
      // memory is current WITHOUT downloading anything: stamp unchanged =
      // run on memory; moved = someone advanced it, pull once first.
      const t = await ctx.db.select({ updatedAt: sessions.transcriptUpdatedAt }).from(sessions)
        .where(eq(sessions.id, s.id));
      return ok({ locked: true, expires_at: expires.toISOString(),
        transcript_updated_at: t[0]?.updatedAt?.toISOString() ?? null });
    });

  app.delete<{ Params: { id: string } }>(
    '/sessions/:id/lock', { schema: { ...TAG,
      summary: 'Release a session',
      description: 'Releases the hold if x-phantom-looper-client is the holder. Idempotent — releasing a session you do not hold changes nothing.',
      params: idParam } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await getSession(ctx.db, req.params.id);
      const released = await releaseLock(ctx.db, req.params.id, client);
      if (released && s) ctx.sessionEvents?.publish(s.id, client, lockEvent(s, { locked: false }));
      if (released) void publishBoardLock(ctx, req.params.id, false);
      // A freed session is the event a skipped looper round waits on — e.g.
      // the cli closing a card's coding session it had open.
      if (released) ctx.looper?.runLoopOfSession(req.params.id, client);
      return ok({ released });
    });

  // ---- interrupt a running turn ---------------------------------------------
  // THE stop signal, one route for every client (esc-esc in the cli, /stop on
  // telegram). Three doors, one effect — the turn stops and so does what it
  // was running: a SERVER-side turn (a looper round or the /turn route) is
  // aborted through `activeTurns`; a turn any OTHER client runs (a cli window,
  // the telegram engine) hears the `interrupt` event on the session feed and
  // aborts its own; and the session's in-flight FOREGROUND commands are
  // killed here directly, because a server-side turn's tool calls ride
  // injectFetch — there is no socket to close, so the disconnect kill in the
  // fs route never fires for them. The turn saves what it recorded and ends
  // cleanly — the looper treats it as an interruption, not a failure: the
  // card is NOT blocked.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/interrupt', { schema: { ...TAG,
      summary: 'Interrupt a running turn',
      description: 'Stops the turn running on this session, whoever runs it: a server-side turn is ' +
        'aborted in place, an {event:"interrupt"} record on GET /sessions/:id/events tells every other ' +
        'client running a turn here (a cli window, the telegram engine) to stop its own, and any ' +
        'foreground bash commands the session has in flight are killed in their container (detached ' +
        'commands are left running by design). The turn saves what it recorded and ends cleanly — the ' +
        'card is not blocked. 200 whether or not a turn was running (idempotent).',
      params: idParam } },
    async (req) => {
      const ac = ctx.activeTurns?.get(req.params.id);
      if (ac) ac.abort();
      ctx.foreground?.killAll(req.params.id);
      // Published under the CALLER's id: the feed never echoes a client its
      // own events, so the caller's own feed is untouched while every other
      // listener — the runner among them — hears it.
      ctx.sessionEvents?.publish(req.params.id, clientOf(req), { event: 'interrupt' });
      return ok({ interrupted: !!ac });
    });

  // ---- the transcript ------------------------------------------------------
  // The conversation, whole — the same JSONL the client keeps locally. SQL is
  // the record: the client uploads the file when a turn ends and rewrites its
  // local copy from here on resume. Entirely optional — a client that never
  // calls these simply has no server transcript, and nothing else cares.
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/transcript', { schema: { ...TAG,
      summary: 'Read a session\'s transcript',
      description: 'The stored conversation (JSONL, header line first), or data: null when none was ever saved. ' +
        'One session, one transcript. Reads are allowed while another client holds the session — watching a ' +
        'running session is safe; only writes need the lock.',
      params: idParam } },
    async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      // The one read that names the blob on purpose.
      const rows = await ctx.db.select({ data: sessions.transcript })
        .from(sessions).where(eq(sessions.id, s.id));
      return ok({ data: rows[0]?.data ?? null, updated_at: s.transcriptUpdatedAt ?? null });
    });

  app.put<{ Params: { id: string }; Body: { data: string } }>(
    '/sessions/:id/transcript', {
      // A conversation with fat tool results outgrows Fastify's default 1MB;
      // the biggest transcript observed in the wild is ~17MB.
      bodyLimit: 64 * 1024 * 1024,
      schema: { ...TAG,
        summary: 'Save a session\'s transcript',
        description: 'Replaces the stored conversation with the client\'s file, whole — one session, one ' +
          'transcript. 409 while another client holds the session; a holder\'s write renews ' +
          'its hold. The last user message is extracted here for the list.',
        params: idParam,
        body: { type: 'object', required: ['data'], additionalProperties: false,
          properties: { data: { type: 'string' } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (heldByOther(s, client)) return reply.code(409).send(lockedErr(s));
      // The same ground truth as the lock route: an expired hold is not an
      // idle session while its turn is still streaming. Without this a lapsed
      // TTL lets a second client overwrite the record the live turn is about
      // to save — the whole file, not a merge.
      if (ctx.activeTurns?.has(s.id) && s.lockedBy && s.lockedBy !== client) {
        return reply.code(409).send(lockedErr(s));
      }
      const data = req.body.data;
      // A list preview, not the record: the UI shows a few dozen characters,
      // and an uncapped copy of a pasted wall of text would ride every
      // GET /sessions response for the life of the session.
      const lastUserMessage = lastUserFromJsonl(data)?.slice(0, LAST_MESSAGE_CHARS) ?? null;
      // The PIN, written ONCE. The first save names the model this session
      // runs on for the rest of its life; no later save moves it. That is what
      // makes the rule enforceable everywhere else: a session with a pin never
      // reads the global settings again, whoever runs the turn.
      const head = headerModelFromJsonl(data);
      const pinning = s.provider == null && s.model == null
        && head.provider != null && head.model != null;
      const stamp = new Date();
      // The token totals ride the save: the whole record is already in memory
      // here, so summing its usage lines costs one pass, and the row's cache
      // lands in the SAME statement as the text it sums — the two can never
      // disagree, and no read ever has to recompute.
      const tokens = sumUsageFromJsonl(data);
      // Every save is one turn: the counter that paces session naming.
      // Who drove it is read off the writer: a person's turn into the loop's
      // coding session takes the session over (sessions.ts agentAfterSave).
      const agent = agentAfterSave(s.agent, client);
      const [saved] = await ctx.db.update(sessions)
        .set({ transcript: data, lastUserMessage, transcriptUpdatedAt: stamp,
          turnCount: sql`${sessions.turnCount} + 1`, agent,
          tokensInput: tokens.input, tokensOutput: tokens.output,
          tokensCacheRead: tokens.cache_read, tokensCacheWrite: tokens.cache_write,
          tokensAsOf: stamp,
          ...(pinning ? { provider: head.provider, model: head.model, baseUrl: head.baseUrl } : {}),
        })
        .where(eq(sessions.id, s.id))
        .returning({ name: sessions.name, turnCount: sessions.turnCount, nameManual: sessions.nameManual });
      // Saving a turn is activity: the session stays off the idle sweep and
      // the holder's lock slides forward without a separate renew call.
      await touchSession(ctx.db, s.id);
      // The record landed: the one moment a client can trust that the server's
      // copy moved. Watchers pull the transcript on this. `by` is the writer,
      // so the window that just uploaded its OWN turn ignores the echo instead
      // of re-pulling and repainting the reply it already drew.
      ctx.sessionEvents?.publish(s.id, client, { event: 'transcript', updated_at: stamp.toISOString(), by: client });
      if (agent !== s.agent) ctx.sessionEvents?.publish(s.id, client, { event: 'session', agent });
      if (client && s.lockedBy === client) {
        const ttl = await resolve(ctx.db, 'session_lock_ttl_ms');
        const expires = await renewLock(ctx.db, s.id, client, Number(ttl));
        ctx.sessionEvents?.publish(s.id, client, lockEvent({ ...s, agent }, { locked: true, expires }));
      }
      // Naming rides the save but never blocks it — fire-and-forget; any
      // failure leaves the old name (or null) standing. A manual name
      // (/rename) turns the titler off for the session.
      if (saved && !saved.nameManual && shouldName(saved.name, saved.turnCount))
        void nameSession(ctx.db, ctx.encryptionKey, s.id, titleContext(data), ctx.modelFetch)
          .then((name) => { if (name) ctx.sessionEvents?.publish(s.id, '', { event: 'session', name }); });
      return ok({ saved: true, bytes: Buffer.byteLength(data), updated_at: stamp.toISOString() });
    });

  // The session's live feed: one long-lived ND-JSON stream per watched
  // session, the board route's shape exactly. Reading is allowed while another
  // client holds the session — watching a running session is safe; only writes
  // need the lock. No replay: a client that joins mid-turn sees the rest, and
  // the `transcript` record tells it when to pull the whole truth.
  //
  // A client never hears itself. Every event names its publisher (the lock
  // holder), and a subscriber's own events are dropped HERE — the one place,
  // for every publisher. A cli window relaying the turn it runs would
  // otherwise get its own tokens back and draw the reply twice; its own
  // transcript save would come back as "moved forward elsewhere".
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/events', { schema: { ...TAG, summary: 'Session events stream',
      description: 'ND-JSON, open until the client hangs up. {event:"turn-start",agent,message} when a ' +
        'turn begins on the session, {event:"part",part} for every AI SDK stream part as it happens (tool ' +
        'results over 16KB are clipped and marked `capped`), {event:"turn-end"}, {event:"error",message}, ' +
        '{event:"interrupt"} when someone stops the turn (the runner aborts its own turn on hearing it), ' +
        '{event:"transcript",updated_at,by} when the record is saved (by ANY client — this is the signal to ' +
        're-read it), {event:"sync",op,step,detail?} for every step of a git sync on the session (a push or ' +
        'pull, whoever kicked it off — a commit-message retry included), ' +
        '{event:"lock",locked,by,label,agent,expires_at} first thing on connect and on every take / ' +
        'renew / release, {event:"session",agent?,planMode?,work?,name?,transcript_updated_at?} on state changes ' +
        'and as a snapshot on every connect, {event:"heartbeat"} every 15 s. Every turn streams here whoever runs it — the server ' +
        'publishes its own, a cli window relays the one it runs through POST /sessions/:id/events. ' +
        'Events published under the reader\'s own x-phantom-looper-client are not sent back to it.',
      params: idParam } },
    async (req, reply) => {
      const client = clientOf(req);
      const write = (o: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(o)}\n`); };
      // Subscribe BEFORE reading: a takeover during the snapshot query must
      // not disappear into the gap between reading and listening.
      let pending: SessionEvent[] | null = [];
      const unsubscribe = ctx.sessionEvents!.subscribe(req.params.id, (e, by) => {
        if (by && by === client) return;
        if (pending) {
          // State writes must survive the read. Live parts are not replayed:
          // the snapshot may already include their saved transcript, and
          // replaying them would draw that turn twice. Mid-turn joins refill
          // from the next transcript event as usual.
          if (e.event === 'lock' || e.event === 'session' || e.event === 'transcript') pending.push(e);
        } else write(e);
      });
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const s = await getSession(ctx.db, req.params.id);
        if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
        if (reply.raw.destroyed) return reply;
        reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
        heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
        write({ event: 'heartbeat' });
        // Opening state always arrives, including when this reader owns the
        // lock: clear any previous remote holder rather than suppressing it.
        write(lockEvent(s, s.lockedBy === client ? { locked: false } : {}));
        write({ event: 'session', agent: s.agent ?? null, planMode: s.planMode, work: s.work ?? null,
          name: s.name ?? null, transcript_updated_at: s.transcriptUpdatedAt?.toISOString() ?? null });
        for (const e of pending) write(e);
        pending = null;
        await new Promise<void>((resolve) => reply.raw.on('close', resolve));
        return reply;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

  // The feed's door for a turn the SERVER does not run: a cli window drives
  // the model on its own machine and relays what it draws — the same records,
  // in the same order, batched the way its screen batches them. Only the
  // session's lock holder may publish: the lock is what makes a turn one
  // turn, so it is also what makes a publisher THE publisher. Nothing is
  // stored; the transcript save at turn end is the record, as ever.
  app.post<{ Params: { id: string }; Body: { events: Record<string, unknown>[] } }>(
    '/sessions/:id/events', {
      bodyLimit: 8 * 1024 * 1024,
      schema: { ...TAG, summary: 'Publish turn events on a session',
        description: 'Relays events of a turn the caller runs onto GET /sessions/:id/events, in order: ' +
          '{event:"turn-start",agent,message}, {event:"part",part} per AI SDK stream part, {event:"turn-end"}, ' +
          '{event:"error",message}. The caller (x-phantom-looper-client) must hold the session lock — 409 ' +
          'otherwise. Tool results are capped like every other publisher\'s. Nothing is stored.',
        params: idParam,
        body: { type: 'object', required: ['events'], additionalProperties: false, properties: {
          events: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['event'],
            properties: { event: { type: 'string', enum: ['turn-start', 'part', 'turn-end', 'error'] } } } } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (s.lockedBy !== client) {
        return reply.code(409).send(s.lockedBy ? lockedErr(s)
          : err('session_not_held', 'hold the session (POST /sessions/:id/lock) before publishing on it'));
      }
      const feed = ctx.sessionEvents!;
      for (const e of req.body.events) {
        if (e.event === 'part') feed.publishPart(s.id, client, e.part);
        else feed.publish(s.id, client, e as SessionEvent);
      }
      return ok({ published: req.body.events.length });
    });

  // Every turn's start, whoever runs it, crosses the session bus — the one
  // place both the server's own turns and a window's relayed turn meet. Two
  // things happen there and nowhere else: the list's preview moves to what
  // was just typed (the save at turn end was the first chance before), and a
  // session's first message names it right away — the record is not needed
  // to say what is being built. Best effort, off the request path.
  ctx.sessionEvents!.subscribeAll((sessionId, e) => {
    if (e.event !== 'turn-start' || e.agent !== 'coding') return;
    void turnStarted(ctx.db, sessionId, e.message).then(async ({ firstMessage }) => {
      if (!firstMessage) return;
      const name = await nameSession(ctx.db, ctx.encryptionKey, sessionId, firstMessageContext(e.message), ctx.modelFetch);
      // The server authored this name — published with no client id, so the
      // window running the turn hears it too (the feed drops a client's own
      // events, and this name belongs to no client).
      if (name) ctx.sessionEvents?.publish(sessionId, '', { event: 'session', name });
    }).catch((err) => log.warn({ session: sessionId, err: errStr(err) }, 'turn-start hook failed'));
  });

  // ---- server-side turns ---------------------------------------------------
  // A server-side turn is a NORMAL session turn whose user message arrives as
  // a string: same openSession, same kits, same frozen
  // prompt, same transcript record — the route is just another headless
  // client of this server's own surface (injectFetch). The reply streams as
  // ND-JSON — {type:text|tool} events as they happen, one final
  // {type:'result'} line — the transport that survives a minutes-long turn.
  app.post<{ Params: { id: string }; Body: { message: string; plan?: boolean } }>(
    '/sessions/:id/turn', { schema: { ...TAG,
      summary: 'Run one coding-agent turn on a session',
      description: 'Sends `message` to the session\'s coding agent and runs the turn to completion ' +
        'server-side. Streams ND-JSON: {type:"text",text} and {type:"tool",name} as they happen, then one ' +
        '{type:"result",text} line. `plan: true` runs the turn with the read-only toolset (plan mode). ' +
        'Holds the session lock for the turn (x-phantom-looper-client names the holder); 409 while someone ' +
        'else holds it. The conversation is saved whole at the end — the same record every client reads.',
      params: idParam,
      body: { type: 'object', required: ['message'], additionalProperties: false,
        properties: { message: { type: 'string', minLength: 1 },
          plan: { type: 'boolean', default: false } } } } },
    async (req, reply) => {
      const client = clientOf(req) || `turn-${Math.random().toString(36).slice(2, 10)}`;
      const f = injectFetch(app);
      let opened;
      try {
        opened = await openSession({ baseUrl: 'http://looper', apiKey: ctx.apiKey,
          clientId: client, label: client, sessionId: req.params.id, fetch: f, lock: true });
      } catch (e) {
        if (e instanceof SessionLockedError) {
          const s = await getSession(ctx.db, req.params.id);
          return reply.code(409).send(s ? lockedErr(s) : err('session_locked', `session ${req.params.id} is in use`, true));
        }
        if ((e as Error).message.includes('session_not_found') || (e as Error).message.includes('not_found')) {
          return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
        }
        throw e;
      }
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (o: unknown) => reply.raw.write(`${JSON.stringify(o)}\n`);
      // This reply is a VIEW of the same feed every watcher reads: subscribe
      // first, then run the turn, and map the parts into the two line shapes
      // this route has always sent. Parts are published in exactly one place
      // (runCodingTurn) — the emitter is synchronous and in-process and the
      // lock guarantees this is the only turn on the session, so subscribing
      // before the run leaves no gap and lets nothing else in.
      const unsubscribe = ctx.sessionEvents!.subscribe(req.params.id, (e) => {
        if (e.event !== 'part') return;
        const p = e.part as { type?: string; text?: string; toolName?: string };
        if (p.type === 'text-delta' && p.text) line({ type: 'text', text: p.text });
        else if (p.type === 'tool-call') line({ type: 'tool', name: p.toolName });
      });
      try {
        const { text } = await runCodingTurn(
          { f, apiKey: ctx.apiKey, base: 'http://looper', modelFetch: ctx.modelFetch,
            sessionEvents: ctx.sessionEvents, client, backdoor: ctx.backdoor },
          opened, opened.session.workspaceId, req.body.message, req.body.plan === true);
        line({ type: 'result', text });
      } catch (e) {
        line({ type: 'error', message: (e as Error).message });
      } finally {
        unsubscribe();
        await opened.close();
        reply.raw.end();
      }
    });

  // ---- the backdoor message queue ------------------------------------------
  // A window's side of the backdoor message queue (backdoor.ts): as its send
  // starts, it drains what is waiting and folds it into the turn ahead of the
  // typed text — the server-side turn runner drains in-process and never
  // crosses here. Drain is take-not-peek: the window records what it got with
  // the turn, and the fact each message reports lives in its own row
  // regardless.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/backdoor/drain', { schema: { ...TAG,
      summary: "Take the session's pending backdoor messages",
      description: 'Drains and returns the one-line backdoor messages waiting for the session\'s next ' +
        'turn (a detached command exiting, a file dropped onto the cli window). The caller folds them ' +
        'into the turn it is starting and records them with it.',
      params: idParam } },
    async (req) => ok({ messages: ctx.backdoor?.drain(req.params.id) ?? [] }));

  // ---- attachments -----------------------------------------------------------
  // A file given to the session out-of-band — the first caller is a drag
  // onto the cli window: the terminal pastes the path, the cli reads the
  // LOCAL file and posts it here. It lands in the session's scratch pad —
  // the same policy telegram attachments follow (attachments.ts). The cli
  // inserts a chip into the user's prompt that expands to the scratch path
  // on submit, so the agent sees the path inline — no backdoor message.
  app.post<{ Params: { id: string }; Body: { name: string; data: string } }>(
    '/sessions/:id/attachments', { schema: { ...TAG,
      summary: 'Attach a file to the session',
      description: 'Saves `data` (base64) under the session\'s scratch dir as `name`. Returns the ' +
        'scratch path; the cli inserts a chip that expands to this path on submit.',
      params: idParam,
      body: { type: 'object', required: ['name', 'data'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1 }, data: { type: 'string' } } } },
      // base64 inflates by 4/3; fastify's 1MB default would refuse every
      // screenshot.
      bodyLimit: Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 1024 },
    async (req, reply) => {
      const session = await getSession(ctx.db, req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const data = Buffer.from(req.body.data, 'base64');
      if (!data.length) return reply.code(400).send(err('invalid_args', 'the file is empty', true));
      if (data.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send(err('too_large', `file is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`, true));
      }
      const scratch = path.join(sessionDir(ctx.paths, session.folderId ?? session.id), 'scratch');
      const a = await writeAttachment(scratch, data, { filename: req.body.name });
      if (!a) return reply.code(422).send(err('invalid_args', 'the file claims to be an image but is not one', true));
      return ok({ path: a.containerPath, kind: a.kind, name: a.displayName });
    });

  // ---- duplicate -----------------------------------------------------------
  // THE way to fork a session — above all, to switch its model: a pinned
  // session never changes model, but its copy is born UNPINNED and follows
  // /model and presets until its first new message, exactly like a fresh
  // session. The whole operation runs under the source's lock (held as every
  // git operation holds it, labelled 'duplicate'): the lock, then the flush
  // (everything outstanding committed and pushed to the source's branch on
  // origin), then the copy cut FROM that branch — so the copy holds all of
  // the source's work, not base's. 409 while someone else holds the source.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/duplicate', { schema: { ...TAG,
      summary: 'Copy a session',
      description: 'Takes the source\'s lock (409 while another client holds it), commits and pushes ' +
        'everything outstanding to the source\'s branch on origin, then creates a NEW session whose own ' +
        'branch is cut FROM that branch — the copy starts with all of the source\'s work. The transcript ' +
        'travels whole minus its usage lines: the copy is born unpinned (its ROW carries no model, so it ' +
        'follows the model settings until its first new message, like a fresh session) and its token ' +
        'totals count its own spend from birth. The frozen system prompt, name and plan mode travel. A destroyed source skips ' +
        'the flush — its branch on origin is the record. A failed flush aborts the copy with the error.',
      params: idParam } },
    async (req, reply) => {
      const src = await getSession(ctx.db, req.params.id);
      if (!src) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      try {
        assertDuplicable(src);
      } catch (e) {
        if (e instanceof SessionError) return reply.code(400).send(err(e.code, e.message));
        throw e;
      }
      // The same ground truth as the lock route: an expired hold is not an
      // idle session while its turn is still streaming — duplicating would
      // flush a tree the live turn is halfway through writing.
      if (ctx.activeTurns?.has(src.id) && src.lockedBy) return reply.code(409).send(lockedErr(src));
      const ttl = await resolve(ctx.db, 'session_lock_ttl_ms');
      const expires = await acquireLock(ctx.db, src, GIT_CLIENT_ID, Number(ttl), 'duplicate');
      if (!expires) return reply.code(409).send(lockedErr(src));
      ctx.sessionEvents?.publish(src.id, GIT_CLIENT_ID, lockEvent(src, { locked: true, by: GIT_CLIENT_ID,
        label: 'duplicate', expires }));
      void publishBoardLock(ctx, src.id, true);
      try {
        const srcFolder = src.folderId ? await getFolder(ctx.db, src.folderId) : undefined;
        // The flush, while the lock keeps every writer out: the copy is cut
        // from what origin has AFTER this, so nothing the source did is lost.
        // A destroyed session has no checkout — its branch on origin is the
        // record, and the cut below fails clearly if even that is gone.
        if (src.status === 'active' && ctx.engine && srcFolder) {
          const workspace = (await ctx.db.select().from(workspaces).where(eq(workspaces.id, src.workspaceId)))[0];
          const r = await ctx.engine.push(src, workspace);
          if (r !== 'pushed' && r !== 'nothing') {
            return reply.code(502).send(err('flush_failed',
              `could not push the session's work to origin first (push ${r}) — the copy was not made`, true));
          }
          // The clone below can outrun the hold's clock; slide it forward so
          // nobody else takes the source mid-copy.
          await renewLock(ctx.db, src.id, GIT_CLIENT_ID, Number(ttl));
        }
        const copy = await createSession(ctx.db, ctx.paths, ctx.encryptionKey, src.workspaceId,
          srcFolder ? { fromBranch: srcFolder.branch } : {});
        const t = await ctx.db.select({ data: sessions.transcript })
          .from(sessions).where(eq(sessions.id, src.id));
        const stamp = new Date();
        await ctx.db.update(sessions).set({
          planMode: src.planMode,
          // The name travels; turn_count stays 0 — the copy renames on its own
          // clock. NO pin, and that is the whole mechanism: the pin lives in
          // the ROW and the copy's row has none, so it follows the model
          // settings until its first new message saves one. The conversation
          // travels untouched — the header still names what the SOURCE ran,
          // and the first new message rewrites it to what the copy ran. NO
          // token totals: the usage lines are stripped below, so the copy
          // counts its own spend from birth.
          ...(t[0]?.data != null ? {
            transcript: stripUsageFromJsonl(rewriteTranscriptHeader(t[0].data, {
              session_id: copy.id, branch: copy.branch,
            })),
            lastUserMessage: src.lastUserMessage, name: src.name, nameManual: src.nameManual,
            transcriptUpdatedAt: stamp,
          } : {}),
        }).where(eq(sessions.id, copy.id));
        return reply.code(201).send(ok({ ...copy, copied_from: src.id }));
      } catch (e) {
        if (e instanceof SessionError) {
          const status = e.code === 'source_branch_gone' ? 409 : 400;
          return reply.code(status).send(err(e.code, e.message, e.retryable));
        }
        throw e;
      } finally {
        await releaseLock(ctx.db, src.id, GIT_CLIENT_ID);
        ctx.sessionEvents?.publish(src.id, GIT_CLIENT_ID, lockEvent(src, { locked: false }));
        void publishBoardLock(ctx, src.id, false);
      }
    });

  app.get<{ Params: { id: string } }>('/sessions/:id', { schema: { ...TAG,
    summary: 'Session metadata, settings resolved',
    description: 'Status, branch, claim_sha, timestamps, plus `settings`: every setting with its layers ' +
      '(default/global/workspace/session) and the computed value + source — the SESSION is the deepest ' +
      'scope, so this is the only view where a session override (auto_push_on_archive) shows resolved. ' +
      'The workspace container is runtime state and has no field here.',
    params: idParam } }, async (req, reply) => {
    const s = await getSession(ctx.db, req.params.id);
    if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    const wsRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
    const settingsOut = await settingsBlock(ctx.db, { workspace: wsRows[0], session: s });
    const folder = s.folderId
      ? (await ctx.db.select().from(folders).where(eq(folders.id, s.folderId)))[0] : undefined;
    const loop = (await ctx.db.select().from(loops)
      .where(or(eq(loops.codingSessionId, s.id), eq(loops.supervisorSessionId, s.id))).limit(1))[0];
    return ok({ ...s, branch: folder?.branch ?? null, card: loop?.card ?? null,
      settings: settingsOut,
      // Computed like the list's, and for the same reason: the cli polls this
      // route while a session runs elsewhere (lock state + stamp, one GET)
      // and must not compare clocks with the server.
      locked: !!s.lockedBy && !!s.lockExpiresAt && s.lockExpiresAt.getTime() > Date.now(),
      // The transcript stamp, for cheap is-my-memory-current checks on
      // switch — on the row since migration 005.
      transcript_updated_at: s.transcriptUpdatedAt?.toISOString() ?? null });
  });

  // ---- token usage ---------------------------------------------------------
  // The totals are written by the transcript SAVE, in the same statement as
  // the text they sum — so this route only reads the row. Rows saved before
  // that write existed (and a duplicate's copy, whose usage lines were
  // stripped) carry nulls: compute from the record once, backfill, and never
  // again.
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/token-usage', { schema: { ...TAG,
      summary: 'A session\'s token totals, summed from its transcript',
      description: 'The row\'s cache of the transcript\'s usage-line sum (one per model call — input, output, ' +
        'cache read/write tokens as the provider reported them), written by the transcript save. `as_of` is ' +
        'the transcript\'s stamp when the sum was computed; `cached` is false only when a row older than ' +
        'the save-time write is backfilled on this read. All zeros when nothing was ever recorded.',
      params: idParam } },
    async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      // A row older than the save-time write: backfill once from the record.
      if (s.tokensInput == null && s.transcriptUpdatedAt) {
        const rows = await ctx.db.select({ data: sessions.transcript })
          .from(sessions).where(eq(sessions.id, s.id));
        const totals = sumUsageFromJsonl(rows[0]?.data ?? '');
        await ctx.db.update(sessions).set({
          tokensInput: totals.input, tokensOutput: totals.output,
          tokensCacheRead: totals.cache_read, tokensCacheWrite: totals.cache_write,
          tokensAsOf: s.transcriptUpdatedAt,
        }).where(eq(sessions.id, s.id));
        return ok({ input: totals.input, output: totals.output,
          cache_read: totals.cache_read, cache_write: totals.cache_write,
          as_of: s.transcriptUpdatedAt.toISOString(), cached: false });
      }
      return ok({ input: s.tokensInput ?? 0, output: s.tokensOutput ?? 0,
        cache_read: s.tokensCacheRead ?? 0, cache_write: s.tokensCacheWrite ?? 0,
        as_of: s.tokensAsOf?.toISOString() ?? null, cached: true });
    });

  app.patch<{ Params: { id: string }; Body: { name?: string | null; plan_mode?: boolean; pinned?: boolean } }>(
    '/sessions/:id', { schema: { ...TAG, summary: 'Per-session overrides',
      description: 'Session values sit at the end of the settings chain: default -> override -> workspace -> session. ' +
        '`name` renames the session by hand — the auto-titler never writes over a manual name; null clears it and ' +
        'hands the session back to the titler. `plan_mode` is the cli\'s /plan switch: while true, clients build ' +
        'the coding agent\'s mutating kits with the readonly preset; every session starts false (code mode). ' +
        '`pinned` is the /pin switch: while true, the session pins to the top of every session list.',
      params: idParam,
      body: { type: 'object', additionalProperties: false,
        properties: { name: { type: ['string', 'null'], maxLength: 80 },
          plan_mode: { type: 'boolean' }, pinned: { type: 'boolean' } } } } }, async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (req.body?.name !== undefined) {
        const name = req.body.name === null ? null : req.body.name.trim();
        if (name === '') return reply.code(400).send(err('invalid_name', 'a name cannot be blank — null clears it'));
        await ctx.db.update(sessions)
          .set({ name, nameManual: name !== null })
          .where(eq(sessions.id, s.id));
        ctx.sessionEvents?.publish(s.id, clientOf(req), { event: 'session', name });
      }
      if (req.body?.plan_mode !== undefined) {
        await ctx.db.update(sessions)
          .set({ planMode: req.body.plan_mode })
          .where(eq(sessions.id, s.id));
        ctx.sessionEvents?.publish(s.id, clientOf(req),
          { event: 'session', planMode: req.body.plan_mode });
      }
      if (req.body?.pinned !== undefined) {
        await ctx.db.update(sessions)
          .set({ pinned: req.body.pinned })
          .where(eq(sessions.id, s.id));
      }
      return ok(await getSession(ctx.db, s.id));
    });

  // Delete = push + teardown: the flush-before-destroy rule. force=true
  // skips the safety only, never the flush attempt. purge=true goes further:
  // the row and the transcript go too — the session stops existing, only its
  // pushed branch on origin survives.
  app.delete<{ Params: { id: string }; Querystring: { force?: string; purge?: string } }>(
    '/sessions/:id', { schema: { ...TAG,
      summary: 'Delete a session',
      description: 'Pushes first (commit + push), then removes the directory and container. Refuses if unpushed work ' +
        'would be lost unless ?force=true — the branch on the remote is what survives. ?purge=true also deletes the ' +
        'row and the server-side transcript, so the session leaves the list for good; refused while another client holds it.',
      params: idParam, querystring: { type: 'object', properties: {
        force: { type: 'string', enum: ['true'] }, purge: { type: 'string', enum: ['true'] } } } } },
    async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const purge = req.query.purge === 'true';
      if (purge && heldByOther(s, clientOf(req))) return reply.code(409).send(lockedErr(s));
      if (!purge && s.status !== 'active') return ok({ already: s.status });
      // A conversation-only session has no checkout: nothing to push first.
      if (s.status === 'active' && ctx.engine && !conversationOnly(s)) {
        const workspaceRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
        if (workspaceRows.length) {
          await ctx.engine.push(s, workspaceRows[0]).catch((e: Error) => {
            log.warn({ session: s.id, err: e.message }, 'push before delete failed — deleting anyway');
          });
        }
      }
      try {
        if (s.status === 'active') {
          await destroySession(ctx.db, ctx.paths, s, { force: req.query.force === 'true' });
          await ctx.engine?.detach(s.id);
          await ctx.fs?.containers.remove(s.id);
        }
        if (!purge) return ok({ destroyed: s.id });
        // The row goes last: its overrides with it, the transcript on it.
        await ctx.db.delete(settingsRows).where(eq(settingsRows.scope, sessionScope(s.id)));
        await ctx.db.delete(sessions).where(eq(sessions.id, s.id));
        return ok({ purged: s.id });
      } catch (e) {
        if (e instanceof SessionError) return reply.code(409).send(err(e.code, e.message));
        throw e;
      }
    });

  // ---- assistant session management ----------------------------------------
  // The voice assistant (TUI) creates and updates assistant sessions through
  // these two routes. The Telegram assistant uses the same functions directly
  // (it lives in the server process).

  app.post<{ Body: { workspace_id: string; folder_id?: string | null } }>(
    '/sessions/assistant', { schema: { ...TAG,
      summary: 'Create an assistant session',
      description: 'Creates a conversation-only session for the assistant, tracked for token usage.',
      body: { type: 'object', required: ['workspace_id'], properties: {
        workspace_id: { type: 'string' },
        folder_id: { type: ['string', 'null'] },
      } } } },
    async (req) => {
      const row = await createAssistantSession(ctx.db, req.body.workspace_id, req.body.folder_id);
      return ok({ id: row.id });
    });

  app.post<{ Params: { id: string }; Body: { usage: { input: number; output: number; cache_read: number; cache_write: number } } }>(
    '/sessions/:id/assistant-usage', { schema: { ...TAG,
      summary: 'Add token usage to an assistant session',
      description: 'Increments the session row\'s token totals by the given amounts.',
      params: idParam,
      body: { type: 'object', required: ['usage'], properties: {
        usage: { type: 'object', required: ['input', 'output', 'cache_read', 'cache_write'], properties: {
          input: { type: 'number' }, output: { type: 'number' },
          cache_read: { type: 'number' }, cache_write: { type: 'number' },
        } },
      } } } },
    async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (s.agent !== 'assistant') return reply.code(400).send(err('not_assistant', 'this route is for assistant sessions only'));
      await addSessionUsage(ctx.db, s.id, req.body.usage);
      return ok({});
    });
}
