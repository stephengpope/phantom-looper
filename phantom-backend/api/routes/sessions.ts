import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, ne, desc, and, or, isNull, isNotNull, lt, sql, count } from 'drizzle-orm';
import { sessions, sessionColumns, workspaces, folders, loops, settings as settingsRows, type SessionRow } from '../../db/schema.js';
import { createSession, getSession, destroySession, touchSession, SessionError,
  heldByOther, acquireLock, releaseLock, renewLock, assertDuplicable, conversationOnly,
  turnStarted, LAST_MESSAGE_CHARS } from '../../sessions.js';
import { repoDir } from '../../pool/paths.js';
import { workState, type WorkState } from '../../git/git.js';
import { scanSkills, mergeSkills } from '../../../core/skills/skills.js';
import { systemSkills } from '../../systemSkills.js';
import { environmentFacts } from '../../environment.js';
import { lastUserFromJsonl, sumUsageFromJsonl } from '../../../core/llm/transcript.js';
import { resolve, settingsBlock, validateSetting } from '../../settings.js';
import { putScoped, dropKey, sessionScope, listSecrets, GLOBAL, workspaceScope } from '../../store.js';
import { ok, err, type AppCtx } from '../app.js';
import { openSession, SessionLockedError } from '../../../core/session.js';
import { injectFetch } from '../../looper/injectFetch.js';
import { runCodingTurn } from '../../looper/turn.js';
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
import { shouldName, nameSession, recentMessages } from '../../sessionTitle.js';
import { logger, errStr } from '../../log.js';

const TAG = { tags: ['sessions'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

// The session lock rides the x-phantom-looper-client header: an opaque id the client
// invents for itself (the TUI mints one per window). Never in a body — the
// same rule as the session header.
const clientOf = (req: FastifyRequest): string => {
  const h = req.headers['x-phantom-looper-client'];
  return typeof h === 'string' ? h : '';
};

const lockedErr = (s: SessionRow) =>
  err('session_locked', `session is in use${s.lockedLabel ? ` on ${s.lockedLabel}` : ''} — duplicate it to work beside the holder`, true);

/** The first line of a transcript is its header; a duplicate keeps the frozen
 *  system prompt but is a different session on a different branch, so those
 *  two fields are rewritten. An unparsable first line is left alone — the
 *  loader skips what it cannot parse, same as everywhere. */
export function rewriteTranscriptHeader(data: string, patch: { session_id: string; branch: string }): string {
  const nl = data.indexOf('\n');
  const first = nl < 0 ? data : data.slice(0, nl);
  try {
    const h = JSON.parse(first) as { type?: string };
    if (h.type !== 'session') return data;
    const line = JSON.stringify({ ...h, ...patch });
    return nl < 0 ? line : line + data.slice(nl);
  } catch { return data; }
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
      const image = await resolve(ctx.db, 'container_image', { workspace });
      const skills = mergeSkills(
        await scanSkills(repoDir(ctx.paths, s.id)),
        ctx.fs ? await systemSkills(ctx.fs.docker, String(image)) : []);
      // The workspace fact a client states in the frozen prompt: resolved
      // NOW (default -> override -> workspace), same name as the setting.
      const agent_git_credentials = await resolve(ctx.db, 'agent_git_credentials', { workspace });
      // The secrets index, frozen the same way as skills: names +
      // descriptions only, global + this workspace, workspace shadowing
      // global by name. secret_list is the live view.
      const byName = new Map<string, { name: string; description: string }>();
      for (const sec of await listSecrets(ctx.db, [GLOBAL, workspaceScope(s.workspaceId)])) {
        if (sec.scope === GLOBAL && byName.has(sec.name)) continue;
        byName.set(sec.name, { name: sec.name, description: sec.description });
      }
      const secrets = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
      // The environment facts line, probed from the fs image (cached by
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
  app.get<{ Querystring: { limit?: number; before?: string; before_id?: string; git?: string;
    typed?: boolean; supervisor?: boolean } }>(
    '/sessions', { schema: { ...TAG,
    summary: 'List sessions',
    description: 'Every session, newest activity first, including destroyed ones (status says which). ' +
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
      git: { type: 'string', enum: ['true'], description: 'Compute `work` per row from the checkout.' } } } } },
  async (req) => {
    // last_user_message rides the list; the transcript blob NEVER does —
    // sessionColumns leaves it out, which is what keeps this list cheap.
    // branch comes from the session's FOLDER, card from its LOOP (either
    // seat) — sessions carry neither themselves.
    const { limit, before, before_id: beforeId } = req.query;
    const cut = before ? new Date(before) : undefined;
    // What the list IS is decided here, once — the filters and the count
    // share one WHERE, so `total` is exactly the rows the pages add up to.
    // The cli used to drop never-typed and supervisor rows itself, which left
    // every page half empty on screen and made its "more" count a guess.
    const filters = [];
    if (req.query.typed === true) filters.push(isNotNull(sessions.lastUserMessage));
    if (req.query.supervisor === false) filters.push(or(isNull(sessions.agent), ne(sessions.agent, 'supervisor')));
    let q = ctx.db
      .select({ ...sessionColumns, branch: folders.branch, card: loops.card })
      .from(sessions)
      .leftJoin(folders, eq(folders.id, sessions.folderId))
      .leftJoin(loops, or(eq(loops.codingSessionId, sessions.id), eq(loops.supervisorSessionId, sessions.id)))
      // id descends too: a page boundary between rows sharing a timestamp
      // must cut the same way every time or the next page skips or repeats.
      .orderBy(desc(sessions.lastUsedAt), desc(sessions.id))
      .$dynamic();
    const cursor = cut && !isNaN(cut.getTime())
      ? (beforeId
        ? or(lt(sessions.lastUsedAt, cut), and(eq(sessions.lastUsedAt, cut), lt(sessions.id, beforeId)))
        : lt(sessions.lastUsedAt, cut))
      : undefined;
    if (filters.length || cursor) q = q.where(and(...filters, ...(cursor ? [cursor] : [])));
    if (limit) q = q.limit(limit);
    const [rows, [{ total }]] = await Promise.all([
      q,
      ctx.db.select({ total: count() }).from(sessions).where(filters.length ? and(...filters) : undefined),
    ]);
    const now = Date.now();
    // `work` on request only: it reads every checkout on disk (local git,
    // no network), which is real time the plain list must not pay. Only a
    // session that OWNS its folder has files to measure; everything else —
    // destroyed, conversation-only, the supervisor's seat — is null, a
    // blank cell. Never an error: a row that cannot be read is null too.
    const work = new Map<string, WorkState | null>();
    if (req.query.git === 'true') {
      const baseOf = new Map((await ctx.db.select().from(workspaces))
        .map((w) => [w.id, w.baseBranch]));
      await Promise.all(rows.map(async (r) => {
        const base = baseOf.get(r.workspaceId);
        if (r.status !== 'active' || r.folderId !== r.id || !r.branch || !base) return;
        work.set(r.id, await workState(repoDir(ctx.paths, r.id), r.branch, base).catch(() => null));
      }));
    }
    // `locked` is computed HERE so no client has to compare clocks with the
    // server; a client only compares locked_by with its own id.
    return ok({ total, sessions: rows.map((r) => ({
      ...r, locked: !!r.lockedBy && !!r.lockExpiresAt && r.lockExpiresAt.getTime() > now,
      ...(req.query.git === 'true' ? { work: work.get(r.id) ?? null } : {}),
    })) });
  });

  // ---- the session lock ----------------------------------------------------
  // One holder per session, named by the x-phantom-looper-client header. Acquire and
  // renew are the same call; there is no takeover — a hold ends by release or
  // by expiry (session_lock_ttl_ms). Copying the session (duplicate) is always
  // open, which is the designed way past a holder.
  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    '/sessions/:id/lock', { schema: { ...TAG,
      summary: 'Hold a session',
      description: 'Claims the session for the client named in x-phantom-looper-client (an opaque id the client invents). ' +
        'While held, no other client may read or write the transcript. Calling again renews the hold; ' +
        'it also expires on its own after session_lock_ttl_ms without renewal. 409 while someone else holds it — ' +
        'there is no takeover; POST /sessions/:id/duplicate works beside a holder.',
      params: idParam,
      body: { type: 'object', additionalProperties: false, properties: {
        label: { type: 'string', maxLength: 200, description: 'What to show others (a hostname).' } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
      const ttl = await resolve(ctx.db, 'session_lock_ttl_ms');
      const expires = await acquireLock(ctx.db, s, client, Number(ttl), req.body?.label);
      if (!expires) return reply.code(409).send(lockedErr(s));
      ctx.sessionEvents?.publish(s.id, client, lockEvent(s, { locked: true, by: client,
        label: req.body?.label ?? s.lockedLabel ?? null, expires }));
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
      // A freed session is the event a skipped looper round waits on — e.g.
      // the cli closing a card's coding session it had open.
      if (released) ctx.looper?.runLoopOfSession(req.params.id, client);
      return ok({ released });
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
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
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
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
      if (heldByOther(s, client)) return reply.code(409).send(lockedErr(s));
      const data = req.body.data;
      // A list preview, not the record: the UI shows a few dozen characters,
      // and an uncapped copy of a pasted wall of text would ride every
      // GET /sessions response for the life of the session.
      const lastUserMessage = lastUserFromJsonl(data)?.slice(0, LAST_MESSAGE_CHARS) ?? null;
      const stamp = new Date();
      // The moved stamp is also what invalidates the cached token totals —
      // tokens_as_of stops matching, and the next token-usage read recomputes.
      // Every save is one turn: the counter that paces session naming.
      const [saved] = await ctx.db.update(sessions)
        .set({ transcript: data, lastUserMessage, transcriptUpdatedAt: stamp,
          turnCount: sql`${sessions.turnCount} + 1` })
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
      if (client && s.lockedBy === client) {
        const ttl = await resolve(ctx.db, 'session_lock_ttl_ms');
        const expires = await renewLock(ctx.db, s.id, client, Number(ttl));
        ctx.sessionEvents?.publish(s.id, client, lockEvent(s, { locked: true, expires }));
      }
      // Naming rides the save but never blocks it — fire-and-forget; any
      // failure leaves the old name (or null) standing. A manual name
      // (/rename) turns the titler off for the session.
      if (saved && !saved.nameManual && shouldName(saved.name, saved.turnCount))
        void nameSession(ctx.db, ctx.encryptionKey, s.id, recentMessages(data), ctx.modelFetch);
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
        '{event:"transcript",updated_at,by} when the record is saved (by ANY client — this is the signal to ' +
        're-read it), {event:"lock",locked,by,label,agent,expires_at} first thing on connect and on every take / ' +
        'renew / release, {event:"heartbeat"} every 15 s. Every turn streams here whoever runs it — the server ' +
        'publishes its own, a cli window relays the one it runs through POST /sessions/:id/events. ' +
        'Events published under the reader\'s own x-phantom-looper-client are not sent back to it.',
      params: idParam } },
    async (req, reply) => {
      const client = clientOf(req);
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (o: unknown) => { reply.raw.write(`${JSON.stringify(o)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const send = (e: SessionEvent, by: string) => { if (by !== client) write(e); };
      const unsubscribe = ctx.sessionEvents!.subscribe(s.id, send);
      write({ event: 'heartbeat' });
      // The one piece of state a feed opens with: who holds the session now.
      // Everything else is a turn in progress (no replay) or the record (the
      // client pulls it); the hold is what the spinner needs before any of
      // that arrives — and after a reconnect.
      send(lockEvent(s), s.lockedBy ?? '');
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
      return reply;
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
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
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
    void turnStarted(ctx.db, sessionId, e.message).then(({ firstMessage }) => {
      if (firstMessage) return nameSession(ctx.db, ctx.encryptionKey, sessionId, `user: ${e.message}`, ctx.modelFetch);
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
          return reply.code(409).send(s ? lockedErr(s) : err('session_locked', 'held', true));
        }
        if ((e as Error).message.includes('session_not_found') || (e as Error).message.includes('not_found')) {
          return reply.code(404).send(err('session_not_found', req.params.id));
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
            sessionEvents: ctx.sessionEvents, client },
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

  // ---- duplicate -----------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/duplicate', { schema: { ...TAG,
      summary: 'Copy a session',
      description: 'Creates a NEW session in the same workspace (fresh checkout, its own branch) ' +
        'and copies the source\'s transcript to it — the frozen system prompt travels, the header\'s session and ' +
        'branch are rewritten. Works while the source is held by someone else: copying is the designed way past ' +
        'the lock. Unpushed work in the source is not in the copy; the copy starts from what origin has.',
      params: idParam } },
    async (req, reply) => {
      const src = await getSession(ctx.db, req.params.id);
      if (!src) return reply.code(404).send(err('session_not_found', req.params.id));
      try {
        assertDuplicable(src);
        const copy = await createSession(ctx.db, ctx.paths, ctx.encryptionKey, src.workspaceId);
        const t = await ctx.db.select({ data: sessions.transcript })
          .from(sessions).where(eq(sessions.id, src.id));
        // Token totals are NOT copied: the copy's transcript carries the
        // same usage lines, so its totals compute on first ask. The name
        // travels; turn_count stays 0 — the copy renames on its own clock.
        // Plan mode travels too — a copy of a planning session is still
        // planning — with or without a transcript to bring along.
        await ctx.db.update(sessions).set({
          planMode: src.planMode,
          ...(t[0]?.data != null ? {
            transcript: rewriteTranscriptHeader(t[0].data, { session_id: copy.id, branch: copy.branch }),
            lastUserMessage: src.lastUserMessage, name: src.name, nameManual: src.nameManual,
            transcriptUpdatedAt: new Date(),
          } : {}),
        }).where(eq(sessions.id, copy.id));
        return reply.code(201).send(ok({ ...copy, copied_from: src.id }));
      } catch (e) {
        if (e instanceof SessionError) return reply.code(400).send(err(e.code, e.message));
        throw e;
      }
    });

  app.get<{ Params: { id: string } }>('/sessions/:id', { schema: { ...TAG,
    summary: 'Session metadata, settings resolved',
    description: 'Status, branch, claim_sha, timestamps, plus `settings`: every setting with its layers ' +
      '(default/global/workspace/session) and the computed value + source — the SESSION is the deepest ' +
      'scope, so this is the only view where a session override (idle_destroy_ms) shows resolved. ' +
      'The workspace container is runtime state and has no field here.',
    params: idParam } }, async (req, reply) => {
    const s = await getSession(ctx.db, req.params.id);
    if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
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
  // Totals are computed ONLY when this route is asked: the transcript's usage
  // lines (one per model call) are summed, and the sums are cached on the row,
  // valid while tokens_as_of still equals transcript_updated_at. A save moves
  // the stamp, so a stale cache is unrepresentable — worst case is one
  // recompute. Nothing at save time does any of this.
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/token-usage', { schema: { ...TAG,
      summary: 'A session\'s token totals, summed from its transcript',
      description: 'Sums the transcript\'s usage lines (one per model call — input, output, cache read/write ' +
        'tokens as the provider reported them) on demand and caches the result against the transcript\'s ' +
        'updated_at stamp. `as_of` is that stamp; `cached` says whether this answer was recomputed or served ' +
        'from the cache. All zeros when nothing was ever recorded.',
      params: idParam } },
    async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
      if (!s.transcriptUpdatedAt) {
        return ok({ input: 0, output: 0, cache_read: 0, cache_write: 0, as_of: null, cached: false });
      }
      if (s.tokensAsOf && s.tokensAsOf.getTime() === s.transcriptUpdatedAt.getTime()
        && s.tokensInput != null) {
        return ok({ input: s.tokensInput, output: s.tokensOutput ?? 0,
          cache_read: s.tokensCacheRead ?? 0, cache_write: s.tokensCacheWrite ?? 0,
          as_of: s.tokensAsOf.toISOString(), cached: true });
      }
      const rows = await ctx.db.select({ data: sessions.transcript, updatedAt: sessions.transcriptUpdatedAt })
        .from(sessions).where(eq(sessions.id, s.id));
      const totals = sumUsageFromJsonl(rows[0]?.data ?? '');
      // Cache stamped with the stamp the sum was computed FROM — a save that
      // lands between the read above and this write just means one more
      // recompute next time, never a wrong answer.
      await ctx.db.update(sessions).set({
        tokensInput: totals.input, tokensOutput: totals.output,
        tokensCacheRead: totals.cache_read, tokensCacheWrite: totals.cache_write,
        tokensAsOf: rows[0]?.updatedAt ?? null,
      }).where(eq(sessions.id, s.id));
      return ok({ input: totals.input, output: totals.output,
        cache_read: totals.cache_read, cache_write: totals.cache_write,
        as_of: rows[0]?.updatedAt?.toISOString() ?? null, cached: false });
    });

  app.patch<{ Params: { id: string }; Body: { idle_destroy_ms?: number; name?: string | null; plan_mode?: boolean } }>(
    '/sessions/:id', { schema: { ...TAG, summary: 'Per-session overrides',
      description: 'Session values sit at the end of the settings chain: default -> override -> workspace -> session. ' +
        '`name` renames the session by hand — the auto-titler never writes over a manual name; null clears it and ' +
        'hands the session back to the titler. `plan_mode` is the cli\'s /plan switch: while true, clients build ' +
        'the coding agent\'s mutating kits with the readonly preset; every session starts false (code mode).',
      params: idParam,
      body: { type: 'object', additionalProperties: false,
        properties: { idle_destroy_ms: { type: ['integer', 'null'] },
          name: { type: ['string', 'null'], maxLength: 80 },
          plan_mode: { type: 'boolean' } } } } }, async (req, reply) => {
      const s = await getSession(ctx.db, req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
      // A session override is a row at session scope, like every other layer —
      // null clears it, same as everywhere.
      if (req.body?.idle_destroy_ms !== undefined) {
        const v = req.body.idle_destroy_ms;
        if (v === null) await dropKey(ctx.db, 'session_idle_destroy_ms', sessionScope(s.id));
        else {
          const bad = validateSetting('session_idle_destroy_ms', v);
          if (bad) return reply.code(400).send(err('invalid_setting', bad));
          await putScoped(ctx.db, ctx.encryptionKey, sessionScope(s.id), 'session_idle_destroy_ms', v, false);
        }
      }
      if (req.body?.name !== undefined) {
        const name = req.body.name === null ? null : req.body.name.trim();
        if (name === '') return reply.code(400).send(err('invalid_name', 'a name cannot be blank — null clears it'));
        await ctx.db.update(sessions)
          .set({ name, nameManual: name !== null })
          .where(eq(sessions.id, s.id));
      }
      if (req.body?.plan_mode !== undefined) {
        await ctx.db.update(sessions)
          .set({ planMode: req.body.plan_mode })
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
      if (!s) return reply.code(404).send(err('session_not_found', req.params.id));
      const purge = req.query.purge === 'true';
      if (purge && heldByOther(s, clientOf(req))) return reply.code(409).send(lockedErr(s));
      if (!purge && s.status !== 'active') return ok({ already: s.status });
      // A conversation-only session has no checkout: nothing to push first.
      if (s.status === 'active' && ctx.engine && !conversationOnly(s)) {
        const workspaceRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
        if (workspaceRows.length) await ctx.engine.push(s, workspaceRows[0]).catch(() => {});
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
}
