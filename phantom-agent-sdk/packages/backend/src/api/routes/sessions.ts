import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SessionRow } from '../../storage/schema.js';
import type { TokenRecord } from '../../storage/TokenLog.js';
import { PERSON } from '@phantom-agent-sdk/client';
import { SessionError, heldByOther, isHeld, expiredHold, assertDuplicable, ownsWorkspace, workspaceOf } from '../../storage/Sessions.js';
import { WorkspaceError } from '../../storage/Workspaces.js';
import { GIT_CLIENT_ID, pushFailed } from '../../git/Git.js';
import { sessionDir } from '../../lib/paths.js';

import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { sessionPin } from '../../agents/AgentConfig.js';
import type { SystemPromptLayout, StoredSystemPrompt } from '@phantom-agent-sdk/client/systemPrompt';
import { SystemPromptError } from '../../agents/SystemPrompt.js';
import { toolsFor } from '../../tools/registry.js';
import { messageLine, userMessage } from '@phantom-agent-sdk/client/transcript';
import { writeAttachment } from '../../telegram/TelegramAttachments.js';
import type { SessionEvent } from '../../agents/SessionEvents.js';

const log = logger('sessions');

/** The session's hold as a feed record — what a watcher's spinner reads.
 *  From the row when the feed opens (`s`), or from the write that just
 *  happened (the overrides). An expired hold reads as free — and says whose
 *  turn died to leave it that way (`died_on`), so a window can tell the
 *  person once instead of pretending the last turn ended cleanly. */
function lockEvent(session: SessionRow, over: Partial<{ locked: boolean; by: string | null; label: string | null;
  expires: Date | null }> = {}): SessionEvent {
  const expires = over.expires !== undefined ? over.expires : session.lockExpiresAt ?? null;
  const locked = over.locked ?? isHeld({ lockedBy: session.lockedBy, lockExpiresAt: expires });
  const died = expiredHold(session);
  return { event: 'lock', locked,
    by: locked ? (over.by !== undefined ? over.by : session.lockedBy) : null,
    label: locked ? (over.label !== undefined ? over.label : session.lockedLabel) : null,
    agent: session.agent ?? null,
    expires_at: locked && expires ? expires.toISOString() : null,
    ...(died ? { died_on: died.label ?? died.by, died_at: died.at.toISOString() } : {}) };
}
import { logger, errStr } from '../../lib/log.js';

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
export const clientOf = (req: FastifyRequest): string => {
  const header = req.headers['x-phantom-looper-client'];
  return typeof header === 'string' ? header : '';
};
/** WHO the client acts for (x-phantom-looper-actor): an automation's own
 *  name, or a person when unsaid. What a session records as started_by and
 *  last_turn_by. */
export const actorOf = (req: FastifyRequest): string => {
  const header = req.headers['x-phantom-looper-actor'];
  return typeof header === 'string' && header ? header : PERSON;
};

export const lockedErr = (session: SessionRow) =>
  err('session_locked', `session is in use${session.lockedLabel ? ` on ${session.lockedLabel}` : ''} — release it there, or wait for the hold to expire`, true);

/** Look up the card the session works on, then publish a board lock event
 *  so the kanban board can show/hide the spinner. Fire-and-forget: a failed
 *  lookup never blocks the lock route. */
async function publishBoardLock(ctx: PhantomBackend, sessionId: string, locked: boolean): Promise<void> {
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
async function releaseHold(ctx: PhantomBackend, session: SessionRow, client: string): Promise<boolean> {
  const released = await ctx.sessions.releaseLock(session.id, client);
  if (released) {
    ctx.sessionEvents.publish(session.id, client, lockEvent(session, { locked: false }));
    void publishBoardLock(ctx, session.id, false);
  }
  return released;
}

/** The agent's system prompt layout, as every create route takes it: three
 *  sections, each a list of server block names and the agent's own text
 *  (@phantom-agent-sdk/client/systemPrompt). */
const layoutSection = { type: 'array', items: { anyOf: [
  { type: 'string', description: 'a server block: soul_md, agents_md, skills_list, secrets_list, time_date, github_token, agent_database' },
  { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } },
] } } as const;
const SYSTEM_PROMPT_LAYOUT = { type: 'object', required: ['stable', 'context', 'volatile'], additionalProperties: false,
  description: 'The agent\'s system prompt layout. Assembled once, written with the row, never changed.',
  properties: { stable: layoutSection, context: layoutSection, volatile: layoutSection } } as const;

/** A create route's one refusal of its own: a block name the server does
 *  not have. */
const unknownBlock = (reply: FastifyReply, error: unknown) =>
  error instanceof SystemPromptError ? reply.code(400).send(err(error.code, error.message)) : undefined;

export function sessionRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  app.post<{ Body: { project_id: string; type: string; id?: string; workspace_session_id?: string | null;
    system_prompt_layout: SystemPromptLayout } }>('/sessions', { schema: { ...TAG,
    summary: 'Create — or restart — a session',
    description: 'Creates a session of `type`, a registered agent type. What the type gets is the type\'s registration: ' +
      'one that OWNS a workspace claims a pre-cloned pool directory (or clones) and checks out the session\'s branch — ' +
      'its own {prefix}/{id}, cut from the base branch, worked in and pushed back to, nothing pushed anywhere else; ' +
      'one that BORROWS reads another session\'s workspace (`workspace_session_id`, or none yet); one with no ' +
      'workspace is a conversation alone. The returned id goes in the x-phantom-looper-session header on every tool call.\n\n' +
      'The session records who opened it (`started_by`) from x-phantom-looper-actor — an automation\'s own name; ' +
      'unsaid = a person. The app\'s background automations are left out of a default GET /sessions.\n\n' +
      'Pass `id` to RESTART an owning session that was destroyed. Destroying a session deletes its files and ' +
      'nothing else — the row keeps its id and its branch — so a restart re-clones, finds that branch on ' +
      'origin, and carries on exactly where it stopped. Restarting a session that is still active is refused.\n\n' +
      '`system_prompt_layout` is the agent\'s prompt layout; the server fills its blocks from that moment\'s ' +
      'skills, secrets, SOUL.md and date, writes the three sections with the row, and answers them as ' +
      '`system_prompt` — sent as stored on every turn. A restart keeps the prompt the session was born with.',
    body: { type: 'object', required: ['project_id', 'type', 'system_prompt_layout'], additionalProperties: false,
      examples: [{ project_id: 'paste the id from POST /projects', type: 'a registered agent type',
        system_prompt_layout: { stable: [{ text: 'You are…' }], context: ['agents_md'], volatile: ['time_date'] } }],
      properties: {
        project_id: { type: 'string' },
        type: { type: 'string', enum: ctx.agentTypes.names(), description: 'The agent type the session runs — a registered type.' },
        id: { type: 'string', description: 'Restart this session id instead of starting a new one (owning types only).' },
        workspace_session_id: { type: ['string', 'null'], description: 'For a borrowing type: the session whose workspace this one reads. Null or absent = nothing to read yet.' },
        system_prompt_layout: SYSTEM_PROMPT_LAYOUT,
      } } } }, async (req, reply) => {
    if (!req.body?.project_id) return reply.code(400).send(err('missing_project', 'body.project_id required'));
    try {
      return reply.code(201).send(ok(await ctx.sessions.start(req.body.project_id, req.body.system_prompt_layout,
        { id: req.body.id, type: req.body.type, startedBy: actorOf(req), workspaceSessionId: req.body.workspace_session_id })));
    } catch (error) {
      if (unknownBlock(reply, error)) return;
      // The session's own refusals, and the checkout's (a dead token, a repo
      // the token cannot see, GitHub unreachable — Workspaces.checkout).
      if (error instanceof SessionError || error instanceof WorkspaceError) {
        const status = error.code === 'already_active' ? 409
          : error.code === 'project_mismatch' || error.code === 'invalid_args'
            || error.code === 'credential_invalid' || error.code === 'credential_insufficient' ? 400
          : error.code === 'upstream_unreachable' ? 502 : 404;
        return reply.code(status).send(err(error.code, error.message, error.retryable));
      }
      throw error;
    }
  });

  // Listing exists for clients that need to show what is open — the TUI
  // launcher, above all. The launcher wants the ended ones too so it can
  // grey them out rather than infer their fate from whether a local
  // transcript happens to exist.
  app.get<{ Querystring: { limit?: number; before?: string; before_id?: string; before_pinned?: boolean;
    typed?: boolean; background?: boolean; q?: string; project?: string; type?: string; started_by?: string; order?: 'activity' | 'created' } }>(
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
      '`workState` rides every row — where the checkout\'s work stands: not_pushed (only on this ' +
      'server\'s disk), not_merged (on origin\'s branch, not in base), merged (in base), or null ' +
      '(never measured). The server\'s periodic git refresh keeps it current for sessions with a running ' +
      'container. `status`, `lastUsedAt`, `lastPushAt` and `branch` are the checkout\'s too, shared by ' +
      'every session on the same workspace.\n\n' +
      '`q` filters: the text as ONE substring, case-insensitive, anywhere in the name, the last ' +
      'user message or the branch. It is part of the list\'s WHERE, so paging and `total` follow it; ' +
      'so is `project` (one project id), `type` (one registered agent type, named outright — a type the ' +
      'registry never lists is reachable this way) and `started_by` (the actor that opened the session: ' +
      '`person`, or an automation\'s name).',
    querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size; omitted = everything.' },
      q: { type: 'string', maxLength: 200, description: 'Substring to match (case-insensitive) in name, last user message or branch.' },
      project: { type: 'string', description: 'Only this project\'s sessions (a project id).' },
      type: { type: 'string', enum: ctx.agentTypes.names(), description: 'Only sessions of this registered agent type, whether or not the registry lists it.' },
      started_by: { type: 'string', description: 'Only sessions this actor opened: `person`, or an automation\'s name.' },
      order: { type: 'string', enum: ['activity', 'created'], description: 'activity (default): pinned first, then newest activity. created: newest row first — one page, no cursor.' },
      typed: { type: 'boolean', description: 'true = only sessions something was typed into (a last message exists).' },
      background: { type: 'boolean', description: 'false = leave out the background sessions: types listed `background` and sessions the app\'s automations opened.' },
      before: { type: 'string', description: 'A row\'s last_used_at (ISO) — return only older activity.' },
      before_id: { type: 'string', description: 'That row\'s id, breaking last_used_at ties.' },
      before_pinned: { type: 'boolean', description: 'That row\'s pinned flag — pinned sorts ahead of activity, so the cursor carries it or a pinned page boundary leaks unpinned rows into the pinned block (and vice versa).' } } } } },
  async (req, reply) => {
    if (req.query.order === 'created' && req.query.before) return reply.code(400).send(err('invalid_args', 'the cursor (before) pages the activity order only'));
    // The list IS the object's (Sessions.list): filters, cursor and count in
    // one place. branch comes from the session's WORKSPACE, the card number and
    // its column from the CARD the row points at.
    const { rows, total } = await (async () => {
      const listed = await ctx.sessions.list({
        typed: req.query.typed, background: req.query.background, q: req.query.q,
        project: req.query.project, type: req.query.type, startedBy: req.query.started_by, order: req.query.order, limit: req.query.limit,
        before: req.query.before ? new Date(req.query.before) : undefined,
        beforeId: req.query.before_id, beforePinned: req.query.before_pinned,
      });
      return { rows: listed.sessions, total: listed.total };
    })();
    const now = Date.now();
    // `locked` is computed HERE so no client has to compare clocks with the
    // server; a client only compares locked_by with its own id.
    return ok({ total, sessions: rows.map((row) => ({ ...row, locked: isHeld(row, now) })) });
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
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('not_found', 'session not found'));
      const project = await ctx.projects.get(session.projectId);
      if (!project) return reply.code(404).send(err('not_found', 'project not found'));
      if (session.status !== 'active') {
        if (!ownsWorkspace(session)) return reply.code(400).send(err('no_files', 'this session has no files of its own'));
        await ctx.sessions.create(session.projectId, { id: session.id, type: session.agent });
      }
      await ctx.sessions.touch(session);
      await ctx.sessionContainers.ensure(workspaceOf(session), project);
      return ok({ pinged: true });
    });

  // ---- interrupt a running turn ---------------------------------------------
  // THE stop signal, one route for every client (esc-esc in the cli, /stop on
  // telegram). One effect — the turn stops and so does what it was running:
  // the client running the turn (a cli window, the backend's own engines)
  // hears the `interrupt` event on the session feed and aborts its own; and
  // the session's in-flight FOREGROUND commands are killed here directly, so
  // a tool call that outlives its turn's socket does not run on. The turn
  // saves what it recorded and ends cleanly — a card run treats it as an
  // interruption, not a failure: the card is NOT blocked.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/interrupt', { schema: { ...TAG,
      summary: 'Interrupt a running turn',
      description: 'Stops the turn running on this session, whoever runs it: an {event:"interrupt"} record on ' +
        'GET /sessions/:id/events tells the client running a turn here (a cli window, the backend\'s own engines) ' +
        'to stop its own, and any ' +
        'foreground bash commands the session has in flight are killed in their container (detached ' +
        'commands are left running by design). The turn saves what it recorded and ends cleanly — the ' +
        'card is not blocked. 200 whether or not a turn was running (idempotent).',
      params: idParam } },
    async (req) => { ctx.sessions.interrupt(req.params.id, clientOf(req), { foreground: ctx.foregroundCommands }); return ok({}); });

  // ---- notify ---------------------------------------------------------------
  // The `send_message` tool's door (tools/notify.ts): the session's agent
  // DMs the user on Telegram, delivered exactly like a reply in a Telegram
  // chat (the app's notification channel). Any client running the
  // session — a cli window, a card run, a cron — reaches Telegram here.
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/sessions/:id/notify', { schema: { ...TAG,
      summary: 'DM the user on Telegram from a session',
      description: 'Sends `text` to the authorized Telegram user as the session\'s agent: markdown formatted, ' +
        'MEDIA:/workspace/... tags and bare /workspace paths delivered as files, spoken when the reply mode says so. ' +
        'The bubble is recorded against the session, so a reply to it enters the session. ' +
        '503 when Telegram is not wired or not enabled — the message says which setting is missing.',
      params: idParam,
      body: { type: 'object', required: ['text'], additionalProperties: false,
        properties: { text: { type: 'string' } } } } },
    async (req, reply) => {
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (!ctx.notifications.available) return reply.code(503).send(err('telegram_unavailable', 'no notification channel is wired on this backend'));
      try {
        await ctx.notifications.send(req.body.text, { sessionId: session.id });
        return ok({ sent: true });
      } catch (error) {
        return reply.code(503).send(err('telegram_unavailable', (error as Error).message));
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
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const data = await ctx.sessions.transcript(session.id, req.query.after);
      return ok({ data, lines: session.transcriptLines, updated_at: session.transcriptUpdatedAt ?? null });
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
            properties: { type: { type: 'string', enum: ['message', 'usage', 'interrupted', 'partial_message', 'system_prompt_rebuilt', 'compaction'] } } } } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (session.lockedBy !== client) {
        return reply.code(409).send(session.lockedBy ? lockedErr(session)
          : err('session_not_held', 'hold the session (POST /sessions/:id/turn-start) before writing to it'));
      }
      let appended: { lines: number; applied: boolean; stamp: Date };
      try {
        appended = await ctx.sessions.appendTranscript(session, client, req.body);
      } catch (error) {
        if (error instanceof SessionError && error.code === 'transcript_conflict') return reply.code(409).send(err(error.code, error.message));
        throw error;
      }
      const ttl = await ctx.settings.resolve('session_lock_ttl_ms');
      await ctx.sessions.renewLock(session.id, client, Number(ttl));
      return ok({ lines: appended.lines, applied: appended.applied, updated_at: appended.stamp.toISOString() });
    });

  app.get('/sessions/events', { schema: { ...TAG, summary: 'Session list events stream',
    description: 'ND-JSON, open until the client hangs up: {event:"changed",id} whenever any session row ' +
      'changes in a way the list shows (hold, save, name, pin, plan mode, work state, create, destroy, ' +
      'purge), plus {event:"heartbeat"} every 15 s. Carries no rows — re-read GET /sessions.' } },
    async (req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (record: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(record)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const unsubscribe = ctx.sessionEvents.subscribeAll((id, event) => {
        if (event.event !== 'part') write({ event: 'changed', id });
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
      const write = (record: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(record)}\n`); };
      // Subscribe BEFORE reading: a takeover during the snapshot query must
      // not disappear into the gap between reading and listening.
      let pending: SessionEvent[] | null = [];
      const unsubscribe = ctx.sessionEvents.subscribe(req.params.id, (event, by) => {
        if (by && by === client) return;
        if (pending) {
          // State writes must survive the read. Live parts are not replayed:
          // the snapshot may already include their saved transcript, and
          // replaying them would draw that turn twice. Mid-turn joins refill
          // from the next transcript event as usual.
          if (event.event === 'lock' || event.event === 'session' || event.event === 'transcript') pending.push(event);
        } else write(event);
      });
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const session = await ctx.sessions.get(req.params.id);
        if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
        if (reply.raw.destroyed) return reply;
        reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
        heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
        write({ event: 'heartbeat' });
        // Opening state always arrives, including when this reader owns the
        // lock: clear any previous remote holder rather than suppressing it.
        write(lockEvent(session, session.lockedBy === client ? { locked: false } : {}));
        write({ event: 'session', agent: session.agent ?? null, planMode: session.planMode, workState: session.workState ?? null,
          name: session.name ?? null, transcript_updated_at: session.transcriptUpdatedAt?.toISOString() ?? null,
          provider: session.provider ?? null, model: session.model ?? null, base_url: session.baseUrl ?? null });
        for (const event of pending) write(event);
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
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (session.lockedBy !== client) {
        return reply.code(409).send(session.lockedBy ? lockedErr(session)
          : err('session_not_held', 'hold the session (POST /sessions/:id/turn-start) before publishing on it'));
      }
      const feed = ctx.sessionEvents;
      for (const event of req.body.events) {
        if (event.event === 'part') feed.publishPart(session.id, client, event.part);
        else feed.publish(session.id, client, event as SessionEvent);
      }
      return ok({ published: req.body.events.length });
    });

  // Every turn's start, whoever runs it, crosses the session bus — the one
  // place every client's relayed turn meets. Two things happen there and
  // nowhere else, for the types a default list shows: the list's preview
  // moves to what was just typed (the save at turn end was the first chance
  // before), and a session's first message names it right away — the record
  // is not needed to say what is being built. Best effort, off the request path.
  ctx.sessionEvents.subscribeAll((sessionId, event) => {
    if (event.event !== 'turn-start' || !ctx.agentTypes.listedNames({ background: false }).includes(event.agent)) return;
    void ctx.sessions.turnStarted(sessionId, event.message).then(async ({ firstMessage }) => {
      if (!firstMessage) return;
      // The row publishes the name under no client id, so the window running
      // the turn hears it too (the feed drops a client's own events).
      await ctx.sessionTitler.name(sessionId, { firstMessage: event.message });
    }).catch((err) => log.warn({ session: sessionId, err: errStr(err) }, 'turn-start hook failed'));
  });

  // ---- attachments -----------------------------------------------------------
  // A file given to the session out-of-band — the first caller is a drag
  // onto the cli window: the terminal pastes the path, the cli reads the
  // LOCAL file and posts it here. It lands in the session's scratch pad —
  // the same policy telegram attachments follow (attachments.ts). The cli
  // inserts a chip into the user's prompt that expands to the scratch path
  // on submit, so the agent sees the path inline — no queued message.
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
      } catch (error) {
        if (error instanceof SessionError) return reply.code(400).send(err(error.code, error.message));
        throw error;
      }
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
        if (src.status === 'active' && src.branch) {
          const project = await ctx.projects.get(src.projectId);
          const pushed = await ctx.git.sync.push(src, project!);
          if (pushed !== 'pushed' && pushed !== 'nothing') {
            return reply.code(502).send(err('flush_failed',
              `could not push the session's work to origin first (${pushFailed(pushed) ? pushed.error : `push ${pushed}`}) — the copy was not made`, true));
          }
          // The clone below can outrun the hold's clock; slide it forward so
          // nobody else takes the source mid-copy.
          await ctx.sessions.renewLock(src.id, GIT_CLIENT_ID, Number(ttl));
        }
        const copy = await ctx.sessions.create(src.projectId, { type: src.agent, ...(src.branch ? { fromBranch: src.branch } : {}) });
        // Copy the source's scratch pad into the copy's workspace — same filenames,
        // the copy's container mounts them at the same /workspace/scratch/ path,
        // so every reference in the transcript works without rewriting.
        const srcScratch = path.join(sessionDir(ctx.paths, workspaceOf(src)), 'scratch');
        const dstScratch = path.join(sessionDir(ctx.paths, copy.id), 'scratch');
        await fs.cp(srcScratch, dstScratch, { recursive: true }).catch(() => {});
        await ctx.sessions.seedCopy(copy, src);
        return reply.code(201).send(ok({ ...copy, copied_from: src.id }));
      } catch (error) {
        if (error instanceof SessionError || error instanceof WorkspaceError) {
          const status = error.code === 'source_branch_gone' ? 409 : 400;
          return reply.code(status).send(err(error.code, error.message, error.retryable));
        }
        throw error;
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
    const session = await ctx.sessions.get(req.params.id);
    if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    const card = await ctx.cards.ofSession(session.id);
    return ok({ ...session, card: card?.number ?? null,
      system_prompt: await ctx.sessions.systemPrompt(session.id),
      // Computed like the list's, and for the same reason: the cli polls this
      // route while a session runs elsewhere (lock state + stamp, one GET)
      // and must not compare clocks with the server.
      locked: isHeld(session),
      // The transcript stamp, for cheap is-my-memory-current checks on
      // switch. (`transcriptUpdatedAt` in the spread is the same value; the
      // cli reads this name.)
      transcript_updated_at: session.transcriptUpdatedAt?.toISOString() ?? null });
  });

  app.patch<{ Params: { id: string }; Body: { name?: string | null; plan_mode?: boolean; pinned?: boolean;
    project_id?: string; workspace_session_id?: string | null } }>(
    '/sessions/:id', { schema: { ...TAG, summary: 'Per-session overrides',
      description: '`name` renames the session by hand — the auto-titler never writes over a manual name; null clears it and ' +
        'hands the session back to the titler. `plan_mode` is the cli\'s /plan switch: while true, clients build ' +
        'the coding agent\'s mutating kits with the readonly preset; every session starts false (code mode). ' +
        '`pinned` is the /pin switch: while true, the session pins to the top of every session list. ' +
        '`project_id` + `workspace_session_id` re-point a BORROWING session at another session\'s files (and project): ' +
        'its tools read that workspace from then on; null = nothing to read. Refused for a type that owns its workspace.',
      params: idParam,
      body: { type: 'object', additionalProperties: false,
        properties: { name: { type: ['string', 'null'], maxLength: 80 },
          plan_mode: { type: 'boolean' }, pinned: { type: 'boolean' },
          project_id: { type: 'string' }, workspace_session_id: { type: ['string', 'null'] } } } } }, async (req, reply) => {
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (req.body?.name !== undefined) {
        const name = req.body.name === null ? null : req.body.name.trim();
        if (name === '') return reply.code(400).send(err('invalid_name', 'a name cannot be blank — null clears it'));
        await ctx.sessions.rename(session.id, name, clientOf(req));
      }
      if (req.body?.plan_mode !== undefined) {
        await ctx.sessions.setPlanMode(session.id, req.body.plan_mode);
      }
      if (req.body?.pinned !== undefined) {
        await ctx.sessions.setPinned(session.id, req.body.pinned);
      }
      if (req.body?.project_id !== undefined || req.body?.workspace_session_id !== undefined) {
        try { await ctx.sessions.repoint(session.id, req.body.project_id ?? session.projectId, req.body.workspace_session_id); }
        catch (error) {
          if (error instanceof SessionError) return reply.code(error.code === 'not_found' ? 404 : 400).send(err(error.code, error.message));
          throw error;
        }
      }
      return ok(await ctx.sessions.get(session.id));
    });

  // Delete = push + teardown: the flush-before-destroy rule. force=true
  // skips the safety only, never the flush attempt. purge=true goes further:
  // the row and the transcript go too — the session stops existing, only its
  // pushed branch on origin survives. Only a session that OWNS its workspace
  // has files to push and remove; a borrowing one has nothing to tear down,
  // so without purge there is nothing to do.
  app.delete<{ Params: { id: string }; Querystring: { force?: string; purge?: string } }>(
    '/sessions/:id', { schema: { ...TAG,
      summary: 'Delete a session',
      description: 'Pushes first (commit + push), then removes the directory and container. Refuses if unpushed work ' +
        'would be lost unless ?force=true — the branch on the remote is what survives. ?purge=true also deletes the ' +
        'row and the server-side transcript, so the session leaves the list for good; refused while another client holds it.',
      params: idParam, querystring: { type: 'object', properties: {
        force: { type: 'string', enum: ['true'] }, purge: { type: 'string', enum: ['true'] } } } } },
    async (req, reply) => {
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      const purge = req.query.purge === 'true';
      if (purge && heldByOther(session, clientOf(req))) return reply.code(409).send(lockedErr(session));
      const hasFiles = ownsWorkspace(session) && session.status === 'active';
      if (!purge && !hasFiles) return ok({ already: ownsWorkspace(session) ? session.status : 'no files' });
      if (hasFiles) {
        const project = await ctx.projects.get(session.projectId);
        if (project) {
          await ctx.git.sync.push(session, project).catch((error: Error) => {
            log.warn({ session: session.id, err: error.message }, 'push before delete failed — deleting anyway');
          });
        }
      }
      try {
        if (hasFiles) {
          await ctx.sessions.destroy(session, { force: req.query.force === 'true' });
          await ctx.git.sync.detach(session.id);
          await ctx.sessionContainers.remove(session.id).catch((error: Error) => {
            log.warn({ session: session.id, err: error.message }, 'files deleted but the container could not be removed');
          });
        }
        if (!purge) return ok({ destroyed: session.id });
        // The row goes last: its overrides with it, the transcript on it.
        await ctx.sessions.purge(session.id);
        return ok({ purged: session.id });
      } catch (error) {
        // unpushed_work (Workspaces.removeFiles) — the caller's call to force.
        if (error instanceof SessionError || error instanceof WorkspaceError) return reply.code(409).send(err(error.code, error.message));
        throw error;
      }
    });

  // The start of a turn, in one request: hold the session, write the
  // messages the server queued for it into the record, and answer what the
  // turn runs on — the model (its key travels only here) and the tools an
  // agent of `type` has right now. The stamp the record was last changed at
  // rides along so the caller knows whether its copy is current. Everything
  // a client needs before its first model call, one round trip.
  app.post<{ Params: { id: string }; Body: { type: string; label?: string; system_prompt_layout?: SystemPromptLayout } }>(
    '/sessions/:id/turn-start', { schema: { ...TAG,
      summary: 'Start a turn: hold the session and answer what it runs on',
      description: 'Holds the session for x-phantom-looper-client (409 session_locked while someone else does), ' +
        'writes the user messages the server queued for this session into the record, and answers the model ' +
        'config (provider, model, key, reasoning, maxSteps) and the tools an agent of `type` has on this ' +
        'session right now, plus the record\'s transcript_updated_at. With `system_prompt_layout`, the prompt\'s ' +
        'volatile section is reassembled from the session\'s facts now (the date, the skills, the secrets), written ' +
        'on the row, marked in the record (a system_prompt_rebuilt line) and answered as `system_prompt`. ' +
        'POST /sessions/:id/turn-ended releases the hold.',
      params: idParam,
      body: { type: 'object', required: ['type'], additionalProperties: false, properties: {
        type: { type: 'string', enum: ctx.agentTypes.names() },
        label: { type: 'string', maxLength: 200, description: 'What to show others (a hostname).' },
        system_prompt_layout: { ...SYSTEM_PROMPT_LAYOUT, description: 'The agent\'s layout: reassemble the volatile section from it before this turn.' } } } } },
    async (req, reply) => {
      const client = clientOf(req);
      if (!client) return reply.code(400).send(err('missing_client', 'x-phantom-looper-client header required'));
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (session.status !== 'active') return reply.code(410).send(err('session_destroyed', `session is ${session.status}`));
      const project = await ctx.projects.get(session.projectId);
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
        if (held) void releaseHold(ctx, session, client);
      });
      const settings = await ctx.settings.resolveMany(['session_lock_ttl_ms'], { projectId: project.id });
      const expires = await ctx.sessions.acquireLock(session, client, Number(settings.session_lock_ttl_ms), req.body.label);
      if (!expires) return reply.code(409).send(lockedErr(session));
      held = true;
      if (callerGone) { await releaseHold(ctx, session, client); return; }
      ctx.sessionEvents.publish(session.id, client, lockEvent(session, { locked: true, by: client, label: req.body.label ?? session.lockedLabel ?? null, expires }));
      if (session.lockedBy !== client) void publishBoardLock(ctx, session.id, true);
      // The server's queued messages land now, under the hold, ahead of
      // whatever the caller sends: the caller reads the record after this.
      const queued = ctx.userMessageQueue.drain(session.id) ?? [];
      // The row as the turn starts: after the hold, after the queued writes.
      let atStart = session;
      if (queued.length) {
        atStart = (await ctx.sessions.get(session.id))!;
        await ctx.sessions.appendTranscript(atStart, client, { after: atStart.transcriptLines, deliveryId: `turn-start-${Date.now()}`,
          lines: queued.map((text) => messageLine(userMessage(text))) });
        atStart = (await ctx.sessions.get(session.id))!;
      }
      // The prompt's volatile section, reassembled under the hold when the
      // turn asked: the record line lands after the queued messages, before
      // anything this turn writes.
      let systemPrompt: StoredSystemPrompt | undefined;
      if (req.body.system_prompt_layout) {
        try { systemPrompt = await ctx.sessions.rebuildVolatileSystemPrompt(atStart, req.body.system_prompt_layout, client); }
        catch (error) {
          await releaseHold(ctx, session, client);
          if (error instanceof SessionError || error instanceof SystemPromptError) return reply.code(400).send(err(error.code, error.message));
          throw error;
        }
        atStart = (await ctx.sessions.get(session.id))!;
      }
      ctx.sessions.rememberLinesAtTurnStart(session.id, atStart.transcriptLines);
      let config;
      try { config = await ctx.agentConfig.resolve(req.body.type, { projectId: project.id }, sessionPin(session)); }
      catch (error) {
        // A refused start is no turn: the hold goes with the refusal, not with the clock.
        await releaseHold(ctx, session, client);
        return reply.code(400).send(err('config_invalid', (error as Error).message));
      }
      const tools = await toolsFor(req.body.type, { app: ctx, session: session, project });
      return ok({ expires_at: expires.toISOString(), transcript_updated_at: atStart.transcriptUpdatedAt?.toISOString() ?? null,
        planMode: session.planMode, config: { model: config.model, maxSteps: config.maxSteps }, tools,
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}) });
    });

  // The end of a turn, whoever ran it, for every kind of session: the turn
  // count (leaving 0 freezes the row's model), the agent seat after the
  // writer, and the auto-title on its cadence — what the whole-file save did
  // for a coding session, now that the record is appended as the turn runs.
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/turn-ended', { schema: { ...TAG,
      summary: 'A turn ended on a session',
      description: 'Records who drove the turn (`last_turn_by`, from x-phantom-looper-actor — a person when unsaid), ' +
        'bumps the turn count (leaving 0 freezes the row\'s model), touches last_used_at, names the session ' +
        'on the titler\'s cadence, and releases the hold turn-start took. 409 while another client holds the session.',
      params: idParam } },
    async (req, reply) => {
      const client = clientOf(req);
      const session = await ctx.sessions.get(req.params.id);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
      if (heldByOther(session, client)) return reply.code(409).send(lockedErr(session));
      const ended = await ctx.sessions.turnEnded(session, actorOf(req));
      if (!ended.nameManual && ctx.sessionTitler.isDue(ended.name, ended.turnCount)) void ctx.sessionTitler.name(session.id);
      // The hold a turn-start took ends here: one request opens a turn, one
      // closes it. A caller that never held it (a whole-file writer of old)
      // releases nothing.
      await releaseHold(ctx, session, client);
      return ok({});
    });

  // The CLI's door to log_tokens: phantom-looper's languageModel records every call
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
