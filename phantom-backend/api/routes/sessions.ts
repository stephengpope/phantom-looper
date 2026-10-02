import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SessionRow } from 'phantom-backend-sdk/schema';
import type { TokenRecord } from 'phantom-backend-sdk';
import { SessionError, heldByOther, isHeld, expiredHold, assertDuplicable, ownsWorkspace, workspaceOf } from 'phantom-backend-sdk';
import { WorkspaceError } from 'phantom-backend-sdk';
import { GIT_CLIENT_ID } from 'phantom-backend-sdk/git';
import { sessionDir } from 'phantom-backend-sdk';

import { ok, err, type AppCtx } from '../app.js';
import { openSession, SessionLockedError } from '../../../core/session.js';
import { injectFetch } from '../../looper/injectFetch.js';
import { runCodingTurn } from '../../looper/turn.js';
import { oldAgentConfig } from '../../agentConfig.js';
import { sessionPin } from '../../agentConfig.js';
import type { SystemPromptLayout } from 'phantom-client-sdk/systemPrompt';
import { SystemPromptError } from 'phantom-backend-sdk';
import { AGENT_NAMES, type AgentName } from '../../../core/llm/agentConfig.js';
import { toolsFor } from '../../tools/registry.js';
import { messageLine, userMessage } from 'phantom-client-sdk/transcript';
import { writeAttachment } from 'phantom-backend-sdk';
import type { SessionEvent } from 'phantom-backend-sdk';

const log = logger('sessions');

/** The session's hold as a feed record — what a watcher's spinner reads.
 *  From the row when the feed opens (`s`), or from the write that just
 *  happened (the overrides). An expired hold reads as free — and says whose
 *  turn died to leave it that way (`died_on`), so a window can tell the
 *  person once instead of pretending the last turn ended cleanly. */
function lockEvent(s: SessionRow, over: Partial<{ locked: boolean; by: string | null; label: string | null;
  expires: Date | null }> = {}): SessionEvent {
  const expires = over.expires !== undefined ? over.expires : s.lockExpiresAt ?? null;
  const locked = over.locked ?? isHeld({ lockedBy: s.lockedBy, lockExpiresAt: expires });
  const died = expiredHold(s);
  return { event: 'lock', locked,
    by: locked ? (over.by !== undefined ? over.by : s.lockedBy) : null,
    label: locked ? (over.label !== undefined ? over.label : s.lockedLabel) : null,
    agent: s.agent ?? null,
    expires_at: locked && expires ? expires.toISOString() : null,
    ...(died ? { died_on: died.label ?? died.by, died_at: died.at.toISOString() } : {}) };
}
import { shouldName, nameSession, titleContext, firstMessageContext } from '../../sessionTitle.js';
import { logger, errStr } from 'phantom-backend-sdk';

const TAG = { tags: ['sessions'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

/** The session's system prompt, frozen ONCE from this moment's facts: the
 *  skills (the repo's .agents/skills/ on the session's branch — scanned AFTER
 *  the checkout, since a claim sits on base until checkoutBranch — merged
 *  with the image's baked /opt/skills, repo shadowing system), the secrets
 *  index (names + descriptions, global + project, project shadowing
 *  global), and the project's resolved agent_git_credentials. A row that
 *  already holds a prompt keeps it (Sessions.freezeSystemPrompt) — a restart
 *  or a re-open never moves a running session's prompt. Called at creation
 *  and, for sessions born before the column, on their first open. */
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

/** Look up the card the session works on, then publish a board lock event
 *  so the kanban board can show/hide the spinner. Fire-and-forget: a failed
 *  lookup never blocks the lock route. */
async function publishBoardLock(ctx: AppCtx, sessionId: string, locked: boolean): Promise<void> {
  try {
    const card = await ctx.cards.ofSession(sessionId);
    if (card) ctx.boardEvents.publish(card.project_id,
      { event: 'session_lock', card: card.number, id: sessionId, locked });
  } catch { /* best-effort — the board refreshes on reconnect anyway */ }
}

/** Let go of a session this client holds, and tell everyone who listens:
 *  the session feed, the board, and the card run that may be waiting for a
 *  free session. THE one release: turn-ended, DELETE /lock and a turn-start
 *  whose caller hung up all come through here. Idempotent — releasing a
 *  session this client does not hold changes nothing. */
async function releaseHold(ctx: AppCtx, s: SessionRow, client: string): Promise<boolean> {
  const released = await ctx.sessions.releaseLock(s.id, client);
  if (released) {
    ctx.sessionEvents.publish(s.id, client, lockEvent(s, { locked: false }));
    void publishBoardLock(ctx, s.id, false);
    ctx.looper?.runLoopOfSession(s.id, client);
  }
  return released;
}

/** The agent's system prompt layout, as every create route takes it: three
 *  sections, each a list of server block names and the agent's own text
 *  (phantom-client-sdk/systemPrompt). */
const layoutSection = { type: 'array', items: { anyOf: [
  { type: 'string', description: 'a server block: soul_md, agents_md, skills_list, secrets_list, time_date, github_token, agent_database' },
  { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } },
] } } as const;
const SYSTEM_PROMPT_LAYOUT = { type: 'object', required: ['stable', 'context', 'volatile'], additionalProperties: false,
  description: 'The agent\'s system prompt layout. Assembled once, written with the row, never changed.',
  properties: { stable: layoutSection, context: layoutSection, volatile: layoutSection } } as const;

/** A create route's one refusal of its own: a block name the server does
 *  not have. */
const unknownBlock = (reply: FastifyReply, e: unknown) =>
  e instanceof SystemPromptError ? reply.code(400).send(err(e.code, e.message)) : undefined;

export function sessionRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.post<{ Body: { project_id: string; id?: string; system_prompt_layout: SystemPromptLayout } }>('/sessions', { schema: { ...TAG,
    summary: 'Create — or restart — a session',
    description: 'Claims a pre-cloned pool directory (or clones) and checks out the session\'s branch: ' +
      'its own {prefix}/{id}, cut from the base branch. That one branch ' +
      'is worked in and pushed back to; nothing is pushed anywhere else. The returned id goes in the ' +
      'x-phantom-looper-session header on every tool call.\n\n' +
      'Pass `id` to RESTART a session that was destroyed. Destroying a session deletes its files and ' +
      'nothing else — the row keeps its id and its branch — so a restart re-clones, finds that branch on ' +
      'origin, and carries on exactly where it stopped. Restarting a session that is still active is refused.\n\n' +
      '`system_prompt_layout` is the agent\'s prompt layout; the server fills its blocks from that moment\'s ' +
      'skills, secrets, SOUL.md and date, writes the three sections with the row, and answers them as ' +
      '`system_prompt` — sent as stored on every turn. A restart keeps the prompt the session was born with.',
    body: { type: 'object', required: ['project_id', 'system_prompt_layout'], additionalProperties: false,
      examples: [{ project_id: 'paste the id from POST /projects',
        system_prompt_layout: { stable: [{ text: 'You are…' }], context: ['agents_md'], volatile: ['time_date'] } }],
      properties: {
        project_id: { type: 'string' },
        id: { type: 'string', description: 'Restart this session id instead of starting a new one.' },
        system_prompt_layout: SYSTEM_PROMPT_LAYOUT,
      } } } }, async (req, reply) => {
    if (!req.body?.project_id) return reply.code(400).send(err('missing_project', 'body.project_id required'));
    try {
      return reply.code(201).send(ok(await ctx.sessions.start(req.body.project_id, req.body.system_prompt_layout, { id: req.body.id })));
    } catch (e) {
      if (unknownBlock(reply, e)) return;
      // The session's own refusals, and the checkout's (a dead token, a repo
      // the token cannot see, GitHub unreachable — Workspaces.checkout).
      if (e instanceof SessionError || e instanceof WorkspaceError) {
        const status = e.code === 'already_active' ? 409
          : e.code === 'project_mismatch' || e.code === 'invalid_args'
            || e.code === 'credential_invalid' || e.code === 'credential_insufficient' ? 400
          : e.code === 'upstream_unreachable' ? 502 : 404;
        return reply.code(status).send(err(e.code, e.message, e.retryable));
      }
      throw e;
    }
  });

  // Listing exists for clients that need to show what is open — the TUI
  // launcher, above all. The launcher wants the ended ones too so it can
  // grey them out rather than infer their fate from whether a local
  // transcript happens to exist.
  app.get<{ Querystring: { limit?: number; before?: string; before_id?: string; before_pinned?: boolean;
    typed?: boolean; background?: boolean; q?: string; project?: string } }>(
    '/sessions', { schema: { ...TAG,
    summary: 'List sessions',
    description: 'Every session, pinned first then newest activity first, including destroyed ones (status says which). ' +
      'Each row carries `locked` (someone holds it right now, label in locked_label/locked_by), ' +
      '`lastUserMessage` (the last thing the user typed, from the server-side transcript) and ' +
      '`name` (a model-written title of what the session is building, best-effort). ' +
      'Join against GET /projects for names.\n\n' +
      'No parameters = the whole list. `limit` returns one page; the next page passes the last ' +
      'row\'s last_used_at as `before` and its id as `before_id` (the tie-break — several rows can ' +
      'share a timestamp). A page shorter than `limit` is the end. The cursor is the values the ' +
      'client SAW, so a session used since simply moves to the top of a later refresh — pages ' +
      'never repeat a row.\n\n' +
      '`work` rides every row — where the checkout\'s work stands: not_pushed (only on this ' +
      'server\'s disk), not_merged (on origin\'s branch, not in base), merged (in base), or null ' +
      '(never measured). The server\'s periodic git refresh keeps it current for sessions with a running ' +
      'container. `status`, `lastUsedAt`, `lastPushAt` and `branch` are the checkout\'s too, shared by ' +
      'every session on the same workspace.\n\n' +
      '`q` filters: the text as ONE substring, case-insensitive, anywhere in the name, the last ' +
      'user message or the branch. It is part of the list\'s WHERE, so paging and `total` follow it; ' +
      'so is `project` (one project id).',
    querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size; omitted = everything.' },
      q: { type: 'string', maxLength: 200, description: 'Substring to match (case-insensitive) in name, last user message or branch.' },
      project: { type: 'string', description: 'Only this project\'s sessions (a project id).' },
      typed: { type: 'boolean', description: 'true = only sessions something was typed into (a last message exists).' },
      background: { type: 'boolean', description: 'false = leave out the background seats: supervisor sessions and cron runs.' },
      before: { type: 'string', description: 'A row\'s last_used_at (ISO) — return only older activity.' },
      before_id: { type: 'string', description: 'That row\'s id, breaking last_used_at ties.' },
      before_pinned: { type: 'boolean', description: 'That row\'s pinned flag — pinned sorts ahead of activity, so the cursor carries it or a pinned page boundary leaks unpinned rows into the pinned block (and vice versa).' } } } } },
  async (req) => {
    // The list IS the object's (Sessions.list): filters, cursor and count in
    // one place. branch comes from the session's WORKSPACE, the card number and
    // its column from the CARD the row points at.
    const { rows, total } = await (async () => {
      const r = await ctx.sessions.list({
        typed: req.query.typed, background: req.query.background, q: req.query.q,
        project: req.query.project, limit: req.query.limit,
        before: req.query.before ? new Date(req.query.before) : undefined,
        beforeId: req.query.before_id, beforePinned: req.query.before_pinned,
      });
      return { rows: r.sessions, total: r.total };
    })();
    const now = Date.now();
    // `locked` is computed HERE so no client has to compare clocks with the
    // server; a client only compares locked_by with its own id.
    return ok({ total, sessions: rows.map((r) => ({ ...r, locked: isHeld(r, now) })) });
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
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      // A running server turn is the truth the clock is not. `activeTurns`
      // holds the live turn's abort controller IN THIS PROCESS, so it cannot
      // outlive the work the way a hold in SQL can — kill the process and the
      // map and the turns die together. A lapsed TTL must therefore never hand
      // the session to a second writer while the first is still streaming:
      // that is two conversations on one transcript, and the last save wins.
      // The holder itself still renews normally.
      if (ctx.activeTurns.has(s.id) && s.lockedBy && s.lockedBy !== client) {
        return reply.code(409).send(lockedErr(s));
      }
      const ttl = await ctx.settings.resolve('session_lock_ttl_ms');
      const expires = await ctx.sessions.acquireLock(s, client, Number(ttl), req.body?.label);
      if (!expires) return reply.code(409).send(lockedErr(s));
      ctx.sessionEvents.publish(s.id, client, lockEvent(s, { locked: true, by: client,
        label: req.body?.label ?? s.lockedLabel ?? null, expires }));
      // Notify the board when a session transitions from unlocked to locked
      // (not on renewals — those fire on every transcript save). The pre-
      // acquire row `s` tells us: same client = renewal, anything else = fresh.
      if (s.lockedBy !== client) void publishBoardLock(ctx, s.id, true);
      // The transcript's stamp rides along so a turn can tell whether its
      // memory is current WITHOUT downloading anything: stamp unchanged =
      // run on memory; moved = someone advanced it, pull once first.
      const stamp = await ctx.sessions.transcriptStamp(s.id);
      return ok({ locked: true, expires_at: expires.toISOString(),
        transcript_updated_at: stamp?.toISOString() ?? null });
    });

  app.delete<{ Params: { id: string } }>(
    '/sessions/:id/lock', { schema: { ...TAG,
      summary: 'Release a session',
      description: 'Releases the hold if x-phantom-looper-client is the holder. Idempotent — releasing a session you do not hold changes nothing.',
      params: idParam } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      return ok({ released: await releaseHold(ctx, s, client) });
    });

  // ---- ping a container -----------------------------------------------------
  // Bring the session back up, whichever layer went: files gone (the disk
  // sweep took them) → clone its branch back; then start the container so
  // the periodic git-status check can read it again. The caller sees `work`
  // update within ~10s via the board event stream. 503 when Docker is not
  // wired (DB-only test environments).
  //
  // The ping is activity: it touches the workspace's lastUsedAt like a tool call
  // does. Without that a session idle past container_idle_ms is started and
  // then reaped again on the next maintenance tick — the reaper reads ONLY
  // that stamp, so it never learned the container was wanted.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/ping', { schema: { ...TAG,
      summary: 'Ping the session container',
      description: 'Brings the session back up: clones its branch back if the files are gone, starts ' +
        'the container if it is not already running, and marks the checkout as used so the idle ' +
        'reaper leaves it up for another container_idle_ms. ' +
        'The periodic git-status refresh picks it up within ~10 seconds and ' +
        'publishes the result on the board event stream. 503 when Docker is not wired.',
      params: idParam,
      body: { type: 'object', additionalProperties: false } } },
    async (req, reply) => {
      if (!ctx.fs) return reply.code(503).send(err('unavailable', 'containers are not wired on this server', false));
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('not_found', 'session not found'));
      const project = await ctx.projects.get(s.projectId);
      if (!project) return reply.code(404).send(err('not_found', 'project not found'));
      if (s.status !== 'active') {
        if (!ownsWorkspace(s)) return reply.code(400).send(err('no_files', 'this session has no files of its own'));
        await ctx.sessions.create(s.projectId, { id: s.id });
      }
      await ctx.sessions.touch(s);
      await ctx.fs.containers.ensure(workspaceOf(s), project);
      return ok({ pinged: true });
    });

  // ---- interrupt a running turn ---------------------------------------------
  // THE stop signal, one route for every client (esc-esc in the cli, /stop on
  // telegram). Three doors, one effect — the turn stops and so does what it
  // was running: a SERVER-side turn (a card-run coding or supervisor turn, or the /turn route) is
  // aborted through `activeTurns`; a turn any OTHER client runs (a cli window,
  // the telegram engine) hears the `interrupt` event on the session feed and
  // aborts its own; and the session's in-flight FOREGROUND commands are
  // killed here directly, because a server-side turn's tool calls ride
  // injectFetch — there is no socket to close, so the disconnect kill in the
  // fs route never fires for them. The turn saves what it recorded and ends
  // cleanly — a card run treats it as an interruption, not a failure: the
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
    async (req) => ok(ctx.sessions.interrupt(req.params.id, clientOf(req), ctx)));

  // ---- notify ---------------------------------------------------------------
  // The `send_message` tool's door (core/llm/tools/notify.ts): the session's
  // agent DMs the user on Telegram, delivered exactly like a reply in a
  // Telegram chat (telegram/engine.ts notify). Any client running the
  // session — a cli window, a card run, a cron — reaches Telegram here.
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/sessions/:id/notify', { schema: { ...TAG,
      summary: 'DM the user on Telegram from a session',
      description: 'Sends `text` to the authorized Telegram user as the session\'s agent: markdown formatted, ' +
        'MEDIA:/workspace/... tags and bare /project paths delivered as files, spoken when the reply mode says so. ' +
        'The bubble is recorded against the session, so a reply to it enters the session. ' +
        '503 when Telegram is not wired or not enabled — the message says which setting is missing.',
      params: idParam,
      body: { type: 'object', required: ['text'], additionalProperties: false,
        properties: { text: { type: 'string' } } } } },
    async (req, reply) => {
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (!ctx.telegram) return reply.code(503).send(err('telegram_unavailable', 'telegram is not wired on this server (no public address)'));
      try {
        await ctx.telegram.notify(s.id, req.body.text);
        return ok({ sent: true });
      } catch (e) {
        return reply.code(503).send(err('telegram_unavailable', (e as Error).message));
      }
    });

  // ---- the transcript ------------------------------------------------------
  // The conversation, whole — the same JSONL the client keeps locally. SQL is
  // the record: the client uploads the file when a turn ends and rewrites its
  // local copy from here on resume. Entirely optional — a client that never
  // calls these simply has no server transcript, and nothing else cares.
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>(
    '/sessions/:id/transcript', { schema: { ...TAG,
      summary: 'Read a session\'s transcript',
      description: 'The stored conversation (JSONL, one line per entry), or data: null when none was ever saved. ' +
        '`lines` is how many lines the record holds. `?after=N` answers only the lines after the first N — what a ' +
        'client that already holds N lines needs to catch up. One session, one transcript. Reads are allowed ' +
        'while another client holds the session — watching a running session is safe; only writes need the lock.',
      params: idParam,
      querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0 } } } } },
    async (req, reply) => {
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const data = await ctx.sessions.transcript(s.id, req.query.after);
      return ok({ data, lines: s.transcriptLines, updated_at: s.transcriptUpdatedAt ?? null });
    });

  // The append: the record grows one batch of typed lines at a time, from
  // whoever holds the session. `after` is the writer's count of the record;
  // the lines land only if the server agrees (else 409 transcript_conflict:
  // read again). `deliveryId` makes a resend safe: a delivery that already
  // landed is answered applied:false, never written twice. A holder's
  // append renews its hold. Nothing else happens here — turn count, seat and
  // naming are the turn-ended route's; the preview and the first name are the
  // turn-start hook's.
  app.post<{ Params: { id: string }; Body: { after: number; deliveryId: string; lines: Record<string, unknown>[] } }>(
    '/sessions/:id/transcript/append', {
      bodyLimit: 64 * 1024 * 1024,
      schema: { ...TAG,
        summary: 'Append lines to a session\'s transcript',
        description: 'Appends typed JSON lines to the record. The caller (x-phantom-looper-client) must hold the session. ' +
          '`after` is how many lines the caller believes the record holds: the append lands only if the server ' +
          'agrees — 409 transcript_conflict otherwise (someone else wrote; read the transcript again). `deliveryId` ' +
          'names this append: resending one that already landed answers {applied:false} and writes nothing.',
        params: idParam,
        body: { type: 'object', required: ['after', 'deliveryId', 'lines'], additionalProperties: false, properties: {
          after: { type: 'integer', minimum: 0 }, deliveryId: { type: 'string', minLength: 1 },
          lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['type'],
            properties: { type: { type: 'string', enum: ['message', 'usage', 'interrupted', 'partial_message', 'compaction'] } } } } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (s.lockedBy !== client) {
        return reply.code(409).send(s.lockedBy ? lockedErr(s)
          : err('session_not_held', 'hold the session (POST /sessions/:id/lock) before writing to it'));
      }
      let r: { lines: number; applied: boolean; stamp: Date };
      try {
        r = await ctx.sessions.appendTranscript(s, client, req.body);
      } catch (e) {
        if (e instanceof SessionError && e.code === 'transcript_conflict') return reply.code(409).send(err(e.code, e.message));
        throw e;
      }
      const ttl = await ctx.settings.resolve('session_lock_ttl_ms');
      await ctx.sessions.renewLock(s.id, client, Number(ttl));
      return ok({ lines: r.lines, applied: r.applied, updated_at: r.stamp.toISOString() });
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
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (heldByOther(s, client)) return reply.code(409).send(lockedErr(s));
      // The same ground truth as the lock route: an expired hold is not an
      // idle session while its turn is still streaming. Without this a lapsed
      // TTL lets a second client overwrite the record the live turn is about
      // to save — the whole file, not a merge.
      if (ctx.activeTurns.has(s.id) && s.lockedBy && s.lockedBy !== client) {
        return reply.code(409).send(lockedErr(s));
      }
      const data = req.body.data;
      // One statement lands the record, its preview and the turn count (the
      // count leaving 0 is what freezes the row's model) — Sessions.saveTranscript;
      // the record event goes out with it. Who drove it is read off the
      // writer: a person's turn into a card run's coding session takes the
      // session over (agentAfterSave).
      const saved = await ctx.sessions.saveTranscript(s, data, client);
      const { stamp, agent } = saved;
      if (client && s.lockedBy === client) {
        const ttl = await ctx.settings.resolve('session_lock_ttl_ms');
        const expires = await ctx.sessions.renewLock(s.id, client, Number(ttl));
        ctx.sessionEvents.publish(s.id, client, lockEvent({ ...s, agent }, { locked: true, expires }));
      }
      // Naming rides the save but never blocks it — fire-and-forget; any
      // failure leaves the old name (or null) standing. A manual name
      // (/rename) turns the titler off for the session.
      if (!saved.nameManual && shouldName(saved.name, saved.turnCount))
        void nameSession(ctx, s.id, titleContext(data), ctx.modelFetch);
      return ok({ saved: true, bytes: Buffer.byteLength(data), updated_at: stamp.toISOString() });
    });

  // Step-level save: updates the transcript and renews the lock, but does NOT
  // bump turn count, trigger naming, pin the model, or publish a transcript
  // event. The lightweight per-step counterpart to the full turn-end PUT above.
  app.post<{ Params: { id: string }; Body: { data: string } }>(
    '/sessions/:id/step', {
      bodyLimit: 64 * 1024 * 1024,
      schema: { ...TAG,
        summary: 'Step-level transcript save',
        description: 'Saves the transcript and renews the lock without the turn-end ceremony ' +
          '(turn count, naming, pinning, events). 409 if the caller does not hold the lock.',
        params: idParam,
        body: { type: 'object', required: ['data'], additionalProperties: false,
          properties: { data: { type: 'string' } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      // The lock must be held by THIS client — the step save is part of a turn.
      if (!s.lockedBy || s.lockedBy !== client) {
        return reply.code(409).send(err('session_locked', 'step save requires the lock'));
      }
      const stamp = await ctx.sessions.stepSave(s, req.body.data);
      // Renew the lock — a long turn with many steps must not expire mid-turn.
      const ttl = await ctx.settings.resolve('session_lock_ttl_ms');
      await ctx.sessions.renewLock(s.id, client, Number(ttl));
      return ok({ saved: true, updated_at: stamp.toISOString() });
    });

  // The LIST's feed: every session's row changes, as notices. No rows ride it
  // — the list is the server's query (Sessions.list: filters, cursor, pinned
  // block), so a listener re-reads GET /sessions rather than adopting a
  // second copy of the list rule. Built on the same bus as the per-session
  // feeds: a turn's tokens (`part`) are left out, everything else — a hold,
  // a save, a name, a pin, a create, a purge — is "this row moved". Not
  // echo-filtered on purpose: the list draws the caller's own sessions too.
  app.get('/sessions/events', { schema: { ...TAG, summary: 'Session list events stream',
    description: 'ND-JSON, open until the client hangs up: {event:"changed",id} whenever any session row ' +
      'changes in a way the list shows (hold, save, name, pin, plan mode, work state, create, destroy, ' +
      'purge), plus {event:"heartbeat"} every 15 s. Carries no rows — re-read GET /sessions.' } },
    async (req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (o: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(o)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const unsubscribe = ctx.sessionEvents!.subscribeAll((id, e) => {
        if (e.event !== 'part') write({ event: 'changed', id });
      });
      write({ event: 'heartbeat' });
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
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
        const s = await ctx.sessions.get(req.params.id);
        if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
        if (reply.raw.destroyed) return reply;
        reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
        heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
        write({ event: 'heartbeat' });
        // Opening state always arrives, including when this reader owns the
        // lock: clear any previous remote holder rather than suppressing it.
        write(lockEvent(s, s.lockedBy === client ? { locked: false } : {}));
        write({ event: 'session', agent: s.agent ?? null, planMode: s.planMode, work: s.work ?? null,
          name: s.name ?? null, transcript_updated_at: s.transcriptUpdatedAt?.toISOString() ?? null,
          provider: s.provider ?? null, model: s.model ?? null, base_url: s.baseUrl ?? null });
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
      const s = await ctx.sessions.get(req.params.id);
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
    void ctx.sessions.turnStarted(sessionId, e.message).then(async ({ firstMessage }) => {
      if (!firstMessage) return;
      // The row publishes the name under no client id, so the window running
      // the turn hears it too (the feed drops a client's own events).
      await nameSession(ctx, sessionId, firstMessageContext(e.message), ctx.modelFetch);
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
        opened = await openSession({ baseUrl: 'http://looper/api', apiKey: ctx.apiKey,
          clientId: client, label: client, sessionId: req.params.id, fetch: f, lock: true });
      } catch (e) {
        if (e instanceof SessionLockedError) {
          const s = await ctx.sessions.get(req.params.id);
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
        const project = await ctx.projects.get(opened.session.projectId);
        const cfg = await oldAgentConfig(ctx.agentConfig, ctx.settings, 'coding', project ? { projectId: project.id } : {}, sessionPin(opened.session));
        const { text } = await runCodingTurn(
          { f, apiKey: ctx.apiKey, base: 'http://looper/api', modelFetch: ctx.modelFetch,
            sessionEvents: ctx.sessionEvents, client, backdoor: ctx.userMessageQueue },
          opened, opened.session.projectId, req.body.message, req.body.plan === true, cfg);
        line({ type: 'result', text });
      } catch (e) {
        line({ type: 'error', message: (e as Error).message });
      } finally {
        unsubscribe();
        await opened.close();
        reply.raw.end();
      }
    });

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
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const data = Buffer.from(req.body.data, 'base64');
      if (!data.length) return reply.code(400).send(err('invalid_args', 'the file is empty', true));
      if (data.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send(err('too_large', `file is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`, true));
      }
      const scratch = path.join(sessionDir(ctx.paths, workspaceOf(session)), 'scratch');
      const a = await writeAttachment(scratch, data, { filename: req.body.name });
      if (!a) return reply.code(422).send(err('invalid_args', 'the file claims to be an image but is not one', true));
      return ok({ path: a.containerPath, kind: a.kind, name: a.displayName });
    });

  // ---- duplicate -----------------------------------------------------------
  // THE way to fork a session — above all, to switch its model: a session
  // that has spoken never changes model, but its copy is a newborn (turn_count
  // 0) on the source's model, so /settings and presets reach it until its first
  // new message. The whole operation runs under the source's lock (held as every
  // git operation holds it, labelled 'duplicate'): the lock, then the flush
  // (everything outstanding committed and pushed to the source's branch on
  // origin), then the copy cut FROM that branch — so the copy holds all of
  // the source's work, not base's. 409 while someone else holds the source.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/duplicate', { schema: { ...TAG,
      summary: 'Duplicate a session',
      description: 'Takes the source\'s lock (409 while another client holds it), commits and pushes ' +
        'everything outstanding to the source\'s branch on origin, then creates a NEW session whose own ' +
        'branch is cut FROM that branch — the copy starts with all of the source\'s work. The transcript ' +
        'travels whole minus its usage lines, so the copy\'s token totals count its own spend from birth. ' +
        'The frozen system prompt, name, plan mode and model travel; the copy is a newborn (turn_count 0), ' +
        'so /settings and presets move its model until its first new message. A destroyed source skips ' +
        'the flush — its branch on origin is the record. A failed flush aborts the copy with the error.',
      params: idParam } },
    async (req, reply) => {
      const src = await ctx.sessions.get(req.params.id);
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
      if (ctx.activeTurns.has(src.id) && src.lockedBy) return reply.code(409).send(lockedErr(src));
      const ttl = await ctx.settings.resolve('session_lock_ttl_ms');
      const expires = await ctx.sessions.acquireLock(src, GIT_CLIENT_ID, Number(ttl), 'duplicate');
      if (!expires) return reply.code(409).send(lockedErr(src));
      ctx.sessionEvents.publish(src.id, GIT_CLIENT_ID, lockEvent(src, { locked: true, by: GIT_CLIENT_ID,
        label: 'duplicate', expires }));
      void publishBoardLock(ctx, src.id, true);
      try {
        // The flush, while the lock keeps every writer out: the copy is cut
        // from what origin has AFTER this, so nothing the source did is lost.
        // A destroyed session has no checkout — its branch on origin is the
        // record, and the cut below fails clearly if even that is gone.
        if (src.status === 'active' && ctx.engine && src.branch) {
          const project = await ctx.projects.get(src.projectId);
          const r = await ctx.engine.push(src, project!);
          if (r !== 'pushed' && r !== 'nothing') {
            return reply.code(502).send(err('flush_failed',
              `could not push the session's work to origin first (push ${r}) — the copy was not made`, true));
          }
          // The clone below can outrun the hold's clock; slide it forward so
          // nobody else takes the source mid-copy.
          await ctx.sessions.renewLock(src.id, GIT_CLIENT_ID, Number(ttl));
        }
        const copy = await ctx.sessions.create(src.projectId, src.branch ? { fromBranch: src.branch } : {});
        // Copy the source's scratch pad into the copy's workspace — same filenames,
        // the copy's container mounts them at the same /workspace/scratch/ path,
        // so every reference in the transcript works without rewriting.
        const srcScratch = path.join(sessionDir(ctx.paths, workspaceOf(src)), 'scratch');
        const dstScratch = path.join(sessionDir(ctx.paths, copy.id), 'scratch');
        await fs.cp(srcScratch, dstScratch, { recursive: true }).catch(() => {});
        await ctx.sessions.seedCopy(copy, src);
        return reply.code(201).send(ok({ ...copy, copied_from: src.id }));
      } catch (e) {
        if (e instanceof SessionError || e instanceof WorkspaceError) {
          const status = e.code === 'source_branch_gone' ? 409 : 400;
          return reply.code(status).send(err(e.code, e.message, e.retryable));
        }
        throw e;
      } finally {
        await ctx.sessions.releaseLock(src.id, GIT_CLIENT_ID);
        ctx.sessionEvents.publish(src.id, GIT_CLIENT_ID, lockEvent(src, { locked: false }));
        void publishBoardLock(ctx, src.id, false);
      }
    });

  app.get<{ Params: { id: string } }>('/sessions/:id', { schema: { ...TAG,
    summary: 'Session metadata',
    description: 'Status, branch, timestamps, `system_prompt` (the frozen prompt the session runs on, ' +
      'in its three sections; null only on a row born before 025). A session runs on its project\'s settings — ' +
      'GET /settings?project=. The workspace container is runtime state and has no field here.',
    params: idParam } }, async (req, reply) => {
    const s = await ctx.sessions.get(req.params.id);
    if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    const card = await ctx.cards.ofSession(s.id);
    return ok({ ...s, card: card?.number ?? null,
      system_prompt: await ctx.sessions.systemPrompt(s.id),
      // Computed like the list's, and for the same reason: the cli polls this
      // route while a session runs elsewhere (lock state + stamp, one GET)
      // and must not compare clocks with the server.
      locked: isHeld(s),
      // The transcript stamp, for cheap is-my-memory-current checks on
      // switch. (`transcriptUpdatedAt` in the spread is the same value; the
      // cli reads this name.)
      transcript_updated_at: s.transcriptUpdatedAt?.toISOString() ?? null });
  });

  app.patch<{ Params: { id: string }; Body: { name?: string | null; plan_mode?: boolean; pinned?: boolean } }>(
    '/sessions/:id', { schema: { ...TAG, summary: 'Per-session overrides',
      description: '`name` renames the session by hand — the auto-titler never writes over a manual name; null clears it and ' +
        'hands the session back to the titler. `plan_mode` is the cli\'s /plan switch: while true, clients build ' +
        'the coding agent\'s mutating kits with the readonly preset; every session starts false (code mode). ' +
        '`pinned` is the /pin switch: while true, the session pins to the top of every session list.',
      params: idParam,
      body: { type: 'object', additionalProperties: false,
        properties: { name: { type: ['string', 'null'], maxLength: 80 },
          plan_mode: { type: 'boolean' }, pinned: { type: 'boolean' } } } } }, async (req, reply) => {
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (req.body?.name !== undefined) {
        const name = req.body.name === null ? null : req.body.name.trim();
        if (name === '') return reply.code(400).send(err('invalid_name', 'a name cannot be blank — null clears it'));
        await ctx.sessions.rename(s.id, name, clientOf(req));
      }
      if (req.body?.plan_mode !== undefined) {
        await ctx.sessions.setPlanMode(s.id, req.body.plan_mode);
      }
      if (req.body?.pinned !== undefined) {
        await ctx.sessions.setPinned(s.id, req.body.pinned);
      }
      return ok(await ctx.sessions.get(s.id));
    });

  // Delete = push + teardown: the flush-before-destroy rule. force=true
  // skips the safety only, never the flush attempt. purge=true goes further:
  // the row and the transcript go too — the session stops existing, only its
  // pushed branch on origin survives. Only a session that OWNS its workspace
  // has files to push and remove; a supervisor's or the assistant's has
  // nothing to tear down, so without purge there is nothing to do.
  app.delete<{ Params: { id: string }; Querystring: { force?: string; purge?: string } }>(
    '/sessions/:id', { schema: { ...TAG,
      summary: 'Delete a session',
      description: 'Pushes first (commit + push), then removes the directory and container. Refuses if unpushed work ' +
        'would be lost unless ?force=true — the branch on the remote is what survives. ?purge=true also deletes the ' +
        'row and the server-side transcript, so the session leaves the list for good; refused while another client holds it.',
      params: idParam, querystring: { type: 'object', properties: {
        force: { type: 'string', enum: ['true'] }, purge: { type: 'string', enum: ['true'] } } } } },
    async (req, reply) => {
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const purge = req.query.purge === 'true';
      if (purge && heldByOther(s, clientOf(req))) return reply.code(409).send(lockedErr(s));
      const hasFiles = ownsWorkspace(s) && s.status === 'active';
      if (!purge && !hasFiles) return ok({ already: ownsWorkspace(s) ? s.status : 'no files' });
      if (hasFiles && ctx.engine) {
        const project = await ctx.projects.get(s.projectId);
        if (project) {
          await ctx.engine.push(s, project).catch((e: Error) => {
            log.warn({ session: s.id, err: e.message }, 'push before delete failed — deleting anyway');
          });
        }
      }
      try {
        if (hasFiles) {
          await ctx.sessions.destroy(s, { force: req.query.force === 'true' });
          await ctx.engine?.detach(s.id);
          await ctx.fs?.containers.remove(s.id).catch((e: Error) => {
            log.warn({ session: s.id, err: e.message }, 'files deleted but the container could not be removed');
          });
        }
        if (!purge) return ok({ destroyed: s.id });
        // The row goes last: its overrides with it, the transcript on it.
        await ctx.sessions.purge(s.id);
        return ok({ purged: s.id });
      } catch (e) {
        // unpushed_work (Workspaces.removeFiles) — the caller's call to force.
        if (e instanceof SessionError || e instanceof WorkspaceError) return reply.code(409).send(err(e.code, e.message));
        throw e;
      }
    });

  // ---- the assistant's session -----------------------------------------------
  // The voice assistant (TUI) opens its session through this route; the
  // Telegram assistant calls createAssistant directly (it lives in the
  // server process).

  const target = { type: 'object', required: ['project_id'], properties: {
    project_id: { type: 'string' },
    session_id: { type: ['string', 'null'], description: 'the session on screen — the assistant reads its files' },
  } } as const;

  app.post<{ Body: { project_id: string; session_id?: string | null; system_prompt_layout: SystemPromptLayout } }>(
    '/sessions/assistant', { schema: { ...TAG,
      summary: 'Create an assistant session',
      description: 'Creates a conversation-only session for the assistant: no checkout of its own, its ' +
        'workspace is the on-screen session\'s (its file tools run as this session and open that workspace). ' +
        'It runs on the row\'s model like every session, and its model calls are billed to it. ' +
        '`system_prompt_layout` as on POST /sessions. Returns the row.',
      body: { ...target, required: [...target.required, 'system_prompt_layout'],
        properties: { ...target.properties, system_prompt_layout: SYSTEM_PROMPT_LAYOUT } } } },
    async (req, reply) => {
      try { return ok(await ctx.sessions.createAssistant(req.body.project_id, req.body.session_id, req.body.system_prompt_layout)); }
      catch (e) { if (unknownBlock(reply, e)) return; throw e; }
    });

  app.post<{ Params: { id: string }; Body: { project_id: string; session_id?: string | null } }>(
    '/sessions/:id/follow', { schema: { ...TAG,
      summary: 'Point an assistant session at the session on screen',
      description: 'Re-points the assistant row\'s project and workspace at what the user is looking at, ' +
        'so its tools read that session\'s files. Assistant sessions only. Returns the row.',
      params: idParam, body: target } },
    async (req, reply) => {
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (s.agent !== 'assistant') return reply.code(400).send(err('not_assistant', 'this route is for assistant sessions only'));
      await ctx.sessions.follow(s.id, req.body.project_id, req.body.session_id);
      return ok(await ctx.sessions.get(s.id));
    });

  // The supervisor's session: conversation-only, on the coder's workspace, on
  // the card. The looper creates one per run.
  app.post<{ Body: { project_id: string; workspace_id: string; card_id: number; system_prompt_layout: SystemPromptLayout } }>(
    '/sessions/supervisor', { schema: { ...TAG,
      summary: 'Create a supervisor session',
      description: 'Creates a conversation-only session for a card run\'s supervisor: no checkout of its own, its ' +
        'workspace is the coder\'s (`workspace_id`), so its file tools read the coder\'s work. ' +
        '`system_prompt_layout` as on POST /sessions. Returns the row.',
      body: { type: 'object', required: ['project_id', 'workspace_id', 'card_id', 'system_prompt_layout'], additionalProperties: false, properties: {
        project_id: { type: 'string' }, workspace_id: { type: 'string' }, card_id: { type: 'integer' },
        system_prompt_layout: SYSTEM_PROMPT_LAYOUT } } } },
    async (req, reply) => {
      try { return ok(await ctx.sessions.createSupervisor(req.body.project_id, req.body.workspace_id, req.body.card_id, req.body.system_prompt_layout)); }
      catch (e) { if (unknownBlock(reply, e)) return; throw e; }
    });

  // The start of a turn, in one request: hold the session, write the
  // messages the server queued for it into the record, and answer what the
  // turn runs on — the model (its key travels only here) and the tools an
  // agent of `type` has right now. The stamp the record was last changed at
  // rides along so the caller knows whether its copy is current. Everything
  // a client needs before its first model call, one round trip.
  app.post<{ Params: { id: string }; Body: { type: AgentName; label?: string } }>(
    '/sessions/:id/turn-start', { schema: { ...TAG,
      summary: 'Start a turn: hold the session and answer what it runs on',
      description: 'Holds the session for x-phantom-looper-client (409 session_locked while someone else does), ' +
        'writes the user messages the server queued for this session into the record, and answers the model ' +
        'config (provider, model, key, reasoning, maxSteps) and the tools an agent of `type` has on this ' +
        'session right now, plus the record\'s transcript_updated_at. POST /sessions/:id/turn-ended releases the hold.',
      params: idParam,
      body: { type: 'object', required: ['type'], additionalProperties: false, properties: {
        type: { type: 'string', enum: [...AGENT_NAMES] },
        label: { type: 'string', maxLength: 200, description: 'What to show others (a hostname).' } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (s.status !== 'active') return reply.code(410).send(err('session_destroyed', `session is ${s.status}`));
      if (ctx.activeTurns.has(s.id) && s.lockedBy && s.lockedBy !== client) return reply.code(409).send(lockedErr(s));
      const project = await ctx.projects.get(s.projectId);
      if (!project) return reply.code(404).send(err('not_found', 'project vanished'));
      // The caller hanging up (a stop pressed while this request was in
      // flight) surfaces as the socket closing with the reply unfinished —
      // the one reliable disconnect signal (tools.ts reads it the same way).
      // The server owns the hold: a hold taken for a caller that is gone is
      // released here, whether the hang-up lands before or after the reply
      // was being written.
      let held = false;
      let callerGone = false;
      reply.raw.on('close', () => {
        if (reply.raw.writableFinished) return;
        callerGone = true;
        if (held) void releaseHold(ctx, s, client);
      });
      const settings = await ctx.settings.resolveMany(['session_lock_ttl_ms'], { projectId: project.id });
      const expires = await ctx.sessions.acquireLock(s, client, Number(settings.session_lock_ttl_ms), req.body.label);
      if (!expires) return reply.code(409).send(lockedErr(s));
      held = true;
      if (callerGone) { await releaseHold(ctx, s, client); return; }
      ctx.sessionEvents.publish(s.id, client, lockEvent(s, { locked: true, by: client, label: req.body.label ?? s.lockedLabel ?? null, expires }));
      if (s.lockedBy !== client) void publishBoardLock(ctx, s.id, true);
      // The server's queued messages land now, under the hold, ahead of
      // whatever the caller sends: the caller reads the record after this.
      const queued = ctx.userMessageQueue.drain(s.id) ?? [];
      // The row as the turn starts: after the hold, after the queued writes.
      let atStart = s;
      if (queued.length) {
        atStart = (await ctx.sessions.get(s.id))!;
        await ctx.sessions.appendTranscript(atStart, client, { after: atStart.transcriptLines, deliveryId: `turn-start-${Date.now()}`,
          lines: queued.map((text) => messageLine(userMessage(text))) });
        atStart = (await ctx.sessions.get(s.id))!;
      }
      ctx.sessions.rememberLinesAtTurnStart(s.id, atStart.transcriptLines);
      let config;
      try { config = await oldAgentConfig(ctx.agentConfig, ctx.settings, req.body.type, { projectId: project.id }, sessionPin(s)); }
      catch (e) { return reply.code(400).send(err('config_invalid', (e as Error).message)); }
      const tools = await toolsFor(req.body.type, { app: ctx, session: s, project });
      return ok({ expires_at: expires.toISOString(), transcript_updated_at: atStart.transcriptUpdatedAt?.toISOString() ?? null,
        planMode: s.planMode, config: { model: config.model, maxSteps: config.maxSteps }, tools });
    });

  // The end of a turn, whoever ran it, for every kind of session: the turn
  // count (leaving 0 freezes the row's model), the agent seat after the
  // writer, and the auto-title on its cadence — what the whole-file save did
  // for a coding session, now that the record is appended as the turn runs.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/turn-ended', { schema: { ...TAG,
      summary: 'A turn ended on a session',
      description: 'Bumps the turn count (leaving 0 freezes the row\'s model), seats the agent after the caller ' +
        '(a person\'s turn into a loop or cron session takes it over), touches last_used_at, and names the session ' +
        'on the titler\'s cadence, and releases the hold turn-start took. 409 while another client holds the session.',
      params: idParam } },
    async (req, reply) => {
      const client = clientOf(req);
      const s = await ctx.sessions.get(req.params.id);
      if (!s) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (heldByOther(s, client)) return reply.code(409).send(lockedErr(s));
      const ended = await ctx.sessions.turnEnded(s, client);
      if (!ended.nameManual && shouldName(ended.name, ended.turnCount)) {
        const data = await ctx.sessions.transcript(s.id);
        if (data) void nameSession(ctx, s.id, titleContext(data), ctx.modelFetch);
      }
      // The hold a turn-start took ends here: one request opens a turn, one
      // closes it. A caller that never held it (a whole-file writer of old)
      // releases nothing.
      await releaseHold(ctx, s, client);
      return ok({});
    });

  // The CLI's door to log_tokens: core's languageModel records every call
  // the CLI process makes, and the CLI's recorder posts it here — the same
  // TokenLog.record the server's own calls land in.
  app.post<{ Body: TokenRecord }>(
    '/log-tokens', { schema: { ...TAG,
      summary: 'Record one model call',
      description: 'Appends one log_tokens entry. For model calls made in the CLI process.',
      body: { type: 'object', required: ['type', 'provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite'],
        properties: {
          sessionId: { type: ['string', 'null'] }, type: { type: 'string' },
          provider: { type: 'string' }, model: { type: 'string' },
          responseId: { type: 'string' },
          input: { type: 'number' }, output: { type: 'number' },
          cacheRead: { type: 'number' }, cacheWrite: { type: 'number' },
        } } } },
    async (req) => {
      await ctx.tokenLog.record(req.body);
      return ok({});
    });
}
