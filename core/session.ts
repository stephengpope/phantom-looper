// The ONE way anything obtains a working session. The cli
// and the server's looper both call this; they differ in arguments, never in
// steps — lock behavior, transcript precedence, and prompt freezing cannot
// drift between callers because they are this one code path.
//
//   1  resolve   no id → create · id+destroyed → restart · id+active → attach
//   2  lock      x-phantom-looper-client; a definite 409 throws SessionLockedError
//   3  pull      the SERVER transcript is the record; what comes back is the
//                working memory the next model call is built from. Nothing
//                flows upward except turn-end saves.
//   4  prompt    the row's frozen system prompt, verbatim — the server froze
//                it when the session was created
//
// Steps 5–6 (agent build, turns) are the caller's to drive: the cli streams
// its agent into a screen, the looper drains turns headless — both build from
// the same core assembly (agentConfig.ts) and save through saveTranscript()
// here, which is what renews the lock.
import type { ModelMessage } from 'ai';
import { parseTranscript, type TranscriptEvent } from './llm/transcript.js';
import type { CodingPrompt } from './llm/agents/coding.js';

export class SessionLockedError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionLockedError'; }
}

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface OpenSessionConfig {
  /** Fetch mode: where the server is. Omitted when `call` is given. */
  baseUrl?: string;
  apiKey?: string;
  /** This client's lock identity (the cli mints one per window; the looper is
   *  `supervisor`). Sent as x-phantom-looper-client on every call in fetch
   *  mode; a caller-supplied `call` sends its own. */
  clientId?: string;
  /** Call mode: an api function that already speaks the envelope and carries
   *  auth + client headers (the cli's `api`). Errors must throw with the
   *  error code in the message. */
  call?: ApiCall;
  /** What to show others while held (a hostname, `supervisor`). */
  label?: string;
  /** Required when creating (no sessionId). */
  workspaceId?: string;
  /** Open this session: active = attach, destroyed = restart. */
  sessionId?: string;
  /** Take the session lock for the whole open (the looper's rounds and the
   *  server turn route — they write immediately and close right after).
   *  Default FALSE: opening is READING — the cli locks per turn, not per
   *  open, so looking at a session never blocks anyone. */
  lock?: boolean;
  fetch?: typeof fetch;
}

export interface SessionInfo {
  id: string; workspaceId: string; branch: string; status: string;
  agent?: string | null; card?: number | null;
  /** The frozen system prompt, in its two cached pieces. Null on a
   *  conversation-only session (a supervisor's, an assistant's). */
  system_prompt: CodingPrompt | null;
  [k: string]: unknown;
}

export interface OpenedSession {
  session: SessionInfo;
  created: boolean;
  /** The conversation, parsed — the working memory. */
  messages: ModelMessage[];
  /** Non-message lines (usage marks and the like) with their positions. A
   *  memory-backed caller rebuilding the record with serializeTranscript
   *  passes these through, or the rebuild silently drops them. */
  events: TranscriptEvent[];
  /** The record verbatim (null when none saved yet) — what a file-backed
   *  caller writes to its working copy. */
  raw: string | null;
  /** The server transcript's stamp at open (null when none saved yet) — the
   *  cheap is-my-memory-current token. */
  updatedAt: string | null;
  /** The frozen system prompt, off the row. Null on a conversation-only
   *  session (the supervisor's) — those build their prompt fresh. */
  prompt: CodingPrompt | null;
  /** Save the conversation (JSONL text), whole — the turn-end write, which
   *  also renews the lock. One session, one transcript. The PUT starts
   *  immediately and the caller moves on; saves land in order, and close()
   *  awaits the last one before releasing the lock, surfacing any failure. */
  saveTranscript(data: string): Promise<void>;
  /** Await the in-flight save, then release the lock (always, idempotent).
   *  Throws if a save failed — the record did not land. */
  close(): Promise<void>;
}

export async function openSession(cfg: OpenSessionConfig): Promise<OpenedSession> {
  const call: ApiCall = cfg.call ?? (async (method, path, body) => {
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.clientId) {
      throw new Error('openSession: baseUrl + apiKey + clientId required without `call`');
    }
    const f = cfg.fetch ?? fetch;
    // content-type ONLY when a body rides along: Fastify 400s a bodyless
    // request that claims application/json — which silently broke the lock
    // RELEASE (DELETE, no body) for every fetch-mode client, so each opened
    // session stayed held for the whole TTL. Same gotcha injectFetch fixed.
    const r = await f(`${cfg.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'x-phantom-looper-client': cfg.clientId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${method} ${path}: ${j.error?.code ?? r.status} ${j.error?.message ?? ''}`);
    return j.data;
  });
  const guarded: ApiCall = async (method, path, body) => {
    try { return await call(method, path, body); }
    catch (e) {
      // An injected `call` carries the envelope's code as a property; the
      // fetch-mode call above keeps it in the message. Either way it is ours.
      if ((e as { code?: string }).code === 'session_locked'
        || (e as Error).message.includes('session_locked')) {
        throw new SessionLockedError((e as Error).message);
      }
      throw e;
    }
  };

  // 1 — resolve
  let session: SessionInfo;
  let created = false;
  if (!cfg.sessionId) {
    if (!cfg.workspaceId) throw new Error('openSession: workspaceId required to create');
    session = await guarded('POST', '/sessions', { workspace_id: cfg.workspaceId }) as SessionInfo;
    created = true;
  } else {
    const existing = await guarded('GET', `/sessions/${cfg.sessionId}`) as SessionInfo;
    if (existing.status === 'active') {
      session = existing;
    } else {
      session = await guarded('POST', '/sessions',
        { workspace_id: existing.workspaceId, id: cfg.sessionId }) as SessionInfo;
      created = true;
    }
  }

  // 2 — lock, only when asked: a writer-for-the-duration (looper round,
  // server turn) locks here and releases at close(). A reader never locks —
  // opening a session is reading its transcript, nothing more.
  if (cfg.lock) {
    await guarded('POST', `/sessions/${session.id}/lock`,
      cfg.label !== undefined ? { label: cfg.label } : {});
  }

  // 3 — the server transcript IS the record
  const t = await guarded('GET', `/sessions/${session.id}/transcript`) as
    { data: string | null; updated_at?: string | null };
  const parsed = parseTranscript(t.data ?? '');

  // The one in-flight save chain: saves never block their caller, only the
  // lock release (close) waits for the tail of this chain.
  let pendingSave: Promise<void> = Promise.resolve();

  return {
    session, created, messages: parsed.messages, events: parsed.events, raw: t.data,
    updatedAt: t.updated_at ?? null, prompt: session.system_prompt ?? null,
    saveTranscript: (data: string) => {
      // The PUT starts now; the caller does not wait on it. Chaining keeps
      // saves in order; the stray .catch keeps a failure from being an
      // unhandled rejection between here and close(), where it surfaces.
      pendingSave = pendingSave
        .then(() => guarded('PUT', `/sessions/${session.id}/transcript`, { data }))
        .then(() => {});
      pendingSave.catch(() => {});
      return Promise.resolve();
    },
    close: async () => {
      // The lock releases only after the record landed: another machine that
      // seats this session next always pulls the complete transcript. The
      // release itself runs even when the save failed (finally) — the failure
      // throws to the caller, who already treats it as the turn's failure.
      try { await pendingSave; }
      finally {
        if (cfg.lock) await call('DELETE', `/sessions/${session.id}/lock`).catch(() => {});
      }
    },
  };
}
