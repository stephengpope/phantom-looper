// The Assistant's tool HANDLERS — the one implementation behind the tool
// definitions in tui.ts, for every host the Assistant runs in: the cli's side
// pane and the Telegram bot. Each was answering the same tools with its own
// code, and the two had drifted (the list's paging, `more`, who drives,
// active/ended, workspace names — present in one, missing in the other).
//
// Everything here is answered over the server's API through `host.call` —
// the same rows and routes whoever asks. What differs between hosts is small
// and named on AssistantHost: where the pointer is, how to switch to a
// session, how to ask the user a yes/no, what to do when a workspace is
// born, and (the cli only) which sessions have a turn streaming locally.
//
// NOT here: the board's card work. The cli answers it from its live
// BoardStore (an optimistic copy the board screen draws from) and moves the
// screen; Telegram answers over the card routes (kanban.ts `cardOpsOverApi`).
import type { ModelMessage } from 'ai';
import type { ApiCall } from '../../session.js';
import { kebabName, renderRead, renderRaw,
  type SessionsArgs, type WorkspaceCreateArgs, type GitAutoPushArgs, type GitAutoPullArgs, type DockerLogsArgs } from './tui.js';
import type { AutoPushOutcome, AutoPullOutcome } from './git.js';
import { parseTranscript } from '../transcript.js';
import { whoDrives, isRunning, ago, type SessionRow } from '../../sessionRows.js';

/** `session_list`'s page, for the ASSISTANT rather than a screen. 50 is a
 *  spoken answer's worth; 100 is the ceiling on one reply. REACH is how far
 *  back offset may go: GET /sessions caps `limit` at 500, and the page is
 *  taken by asking for offset+limit rows and dropping the first offset — so
 *  offset+limit must stay inside the server's cap. */
export const SESSION_PAGE = 50, SESSION_MAX = 100, SESSION_REACH = 500;

/** One line, capped — a session's last message identifies it; the rest of a
 *  pasted essay is noise in a list of twenty. */
const oneLine = (s: string | null | undefined, max = 80): string | null => {
  if (!s) return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** What a host supplies: the API, its identity, where the user is, and the
 *  few actions only the host can perform. */
export interface AssistantHost {
  /** Unwrapped API call — resolves with `data`, throws with the server's words. */
  call: ApiCall;
  /** The host's session-lock id: a hold by anyone else IS a turn running. */
  clientId: string;
  /** POST /git/auto-push and /git/auto-pull for one session, through core's
   *  one client of each (git.ts) over this host's connection; `onStep` gets
   *  each step in words as it happens. */
  autoPush(sessionId: string, onStep?: (label: string) => void): Promise<AutoPushOutcome>;
  autoPull(sessionId: string, onStep?: (label: string) => void): Promise<AutoPullOutcome>;
  /** The workspace the Assistant is standing in, or null. */
  workspaceId(): string | null;
  /** The session the Assistant is pointed at, or null. */
  activeSession(): string | null;
  /** A turn streaming in THIS host right now (the cli's local turns). */
  busy?(sessionId: string): boolean;
  /** The conversation this host holds in memory for an open session, if any
   *  (the cli). Absent → the server's transcript is read. */
  history?(sessionId: string): ModelMessage[] | null;
  /** session_switch: point at (and, on the cli, open) this session. Resolves
   *  with the tool's answer. */
  onSwitch(id: string): Promise<unknown>;
  /** session_close, where closing means something (the cli). Absent → the
   *  tool is not offered. */
  onClose?(id?: string): Promise<unknown>;
  /** The approval gate: show the ask, resolve with the answer; abort declines. */
  approve(ask: { label: string; subject: string }, signal?: AbortSignal): Promise<boolean>;
  /** A workspace was just created — make it the place the user is. */
  onWorkspaceCreated(workspaceId: string): Promise<{ session?: string; error?: string }>;
  /** Steps of a push/pull as they happen (the cli notes them into the pane). */
  onGitStep?(sessionId: string, label: string): void;
}

/** The `session_*` family, one handler.
 *
 *  LIST is the SERVER's answer, never a host's memory: the cli's store only
 *  holds the sessions opened there, and listing from it made the Assistant
 *  say "just one" while the workspace held fifty. Paging is offset/limit
 *  (something a model can reason about); the page is ONE request — the rows
 *  up to the end of the window plus one LOOKAHEAD row, so `more` is known,
 *  not guessed from a full page — and never re-sorted: the order has one
 *  home, on the server. */
export function sessionsHandler(host: AssistantHost) {
  return async (args: SessionsArgs): Promise<unknown> => {
    const on_screen = host.activeSession();
    if (args.action === 'list') {
      const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? SESSION_PAGE)), SESSION_MAX);
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      const want = offset + limit + 1;
      if (want > SESSION_REACH) {
        return { error: `the list reaches ${SESSION_REACH} sessions back; offset + limit must stay inside that`, on_screen };
      }
      let rows: SessionRow[];
      // The workspace by NAME: a 26-character id cannot be spoken. The list
      // rides along in parallel — one round trip's worth of time.
      const names = new Map<string, string>();
      try {
        const [got, ws] = await Promise.all([
          host.call('GET', `/sessions?typed=true&limit=${want}`) as Promise<{ sessions?: unknown }>,
          host.call('GET', '/workspaces') as Promise<Array<{ id: string; name: string; displayName?: string | null }>>,
        ]);
        // A server that answers something other than a list is a broken
        // server, not a crashed tool: say so and keep the host usable.
        rows = Array.isArray(got?.sessions) ? got.sessions as SessionRow[] : [];
        for (const w of Array.isArray(ws) ? ws : []) names.set(w.id, w.displayName || w.name);
      } catch (e) {
        return { error: `could not list sessions: ${(e as Error).message}`, on_screen };
      }
      const page = rows.slice(offset, offset + limit);
      return {
        showing: `${page.length} session${page.length === 1 ? '' : 's'}, newest activity first`
          + (offset ? ` (skipping the ${offset} most recent)` : ''),
        more: rows.length > offset + limit,
        on_screen,
        sessions: page.map((s) => ({
          id: s.id,
          name: s.name ?? null,
          workspace: names.get(s.workspaceId) ?? s.workspaceId,
          branch: s.branch ?? null,
          card: s.card ?? null,
          card_status: s.cardStatus ?? null,
          // Supervisor rows are MARKED, not hidden: a list that silently
          // drops half of itself is a list that lies.
          kind: whoDrives(s),
          status: s.status === 'active' ? 'active' : 'ended',
          running: isRunning(s, { busy: host.busy, clientId: host.clientId }),
          on_screen: s.id === on_screen,
          git_status: s.work ?? null,
          model: s.model ?? null,
          tokens: s.tokensOutput ?? null,
          last_message: oneLine(s.lastUserMessage),
          when: ago(s.lastUsedAt),
        })),
      };
    }
    if (args.action === 'switch') {
      // Exact ids only — they come from session_list in the same breath. A
      // prefix match once landed on the wrong conversation.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'session_switch needs an id — session_list has them' };
      return host.onSwitch(id);
    }
    if (args.action === 'close') {
      if (!host.onClose) return { error: 'closing a session means nothing here' };
      return host.onClose(args.id ? String(args.id).trim() : undefined);
    }
    if (args.action === 'read') {
      const id = args.id ? String(args.id) : on_screen;
      if (!id) return { error: 'no session — pass an id (session_list has them)' };
      // Raw asks for the server's record: the JSONL transcript is the exact
      // event log. Rendered reads come from the host's memory when it holds
      // the session (the cli's open sessions), else from the same record.
      try {
        if (args.raw) {
          const j = await host.call('GET', `/sessions/${id}/transcript`) as { data?: string };
          return { text: renderRaw(String(j?.data ?? '')) };
        }
        const held = host.history?.(id);
        const messages = held ?? parseTranscript(String(
          ((await host.call('GET', `/sessions/${id}/transcript`)) as { data?: string })?.data ?? '')).messages;
        return { text: renderRead(id, messages, { limit: args.limit, offset: args.offset, tools: args.tools }) };
      } catch (e) {
        return { error: `could not read session ${id}: ${(e as Error).message}` };
      }
    }
    return { error: `unknown action ${String(args.action)}` };
  };
}

/** `workspace_create_repo`: kebab the name, get the user's accept on the
 *  FINAL name (the point of the gate), then the backend does the whole flow
 *  (POST /workspaces create=true: repo, seed, register; always private, not
 *  the model's call) and the host makes the new workspace the place the user
 *  is. */
export function workspaceCreateHandler(host: AssistantHost) {
  return async (args: WorkspaceCreateArgs, opts: { abortSignal?: AbortSignal }): Promise<unknown> => {
    const name = kebabName(args.name ?? '');
    if (!name) return { error: 'no usable name — ask for the project name again' };
    const ok = await host.approve({ label: 'new private repo', subject: name }, opts.abortSignal);
    if (!ok) {
      return { declined: true, note: 'nothing was created — the user declined (or the turn was cut off). ' +
        'Often the name was misheard: ask what to change before calling again.' };
    }
    try {
      const w = await host.call('POST', '/workspaces', {
        url: name, create: true, private: true,
        ...(args.description ? { description: args.description } : {}),
      }) as { id: string; owner: string; name: string };
      const opened = await host.onWorkspaceCreated(w.id);
      return { ok: true, repo: `${w.owner}/${w.name}`, private: true, workspace_id: w.id,
        ...(opened.session ? { entered: 'a new session in the new workspace' }
          : { note: `workspace created, but no session could be opened: ${opened.error ?? 'unknown'}` }) };
    } catch (e) { return { error: (e as Error).message }; }
  };
}

/** `git_auto_push` / `git_auto_pull`: the pointed-at session unless an id was
 *  given, through core's one client of each git route, awaited to the end so
 *  the Assistant can say how it went. A refusal is the answer, never a throw. */
export function gitHandlers(host: AssistantHost) {
  const target = (args: { id?: string }) => args.id ?? host.activeSession();
  const steps = (id: string) => (label: string) => host.onGitStep?.(id, label);
  return {
    push: async (args: GitAutoPushArgs): Promise<unknown> => {
      const id = target(args);
      if (!id) return { error: 'no session is open — nothing to push' };
      try { return { session: id, ...await host.autoPush(id, steps(id)) }; }
      catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }
    },
    pull: async (args: GitAutoPullArgs): Promise<unknown> => {
      const id = target(args);
      if (!id) return { error: 'no session is open — nothing to pull into' };
      try { return { session: id, ...await host.autoPull(id, steps(id)) }; }
      catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }
    },
  };
}

/** `docker_logs`: the args straight through to POST /system/logs — the route
 *  does the narrowing; the result is just shaped for the model. */
export function dockerLogsHandler(host: AssistantHost) {
  return async (args: DockerLogsArgs): Promise<unknown> => {
    let d: { service: string; text: string; truncated?: boolean };
    try { d = await host.call('POST', '/system/logs', args) as typeof d; }
    catch (e) { return { error: (e as Error).message }; }
    return {
      service: d.service,
      text: d.text || '(no matching log lines)',
      ...(d.truncated ? { truncated: 'output hit the 64 KB cap — narrow with tail/since/grep and retry' } : {}),
    };
  };
}
