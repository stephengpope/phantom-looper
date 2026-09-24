// An in-memory phantom-backend behind a `fetch`: the routes the SDK uses,
// with the rules that matter — the session lock, the write-once freeze, and
// the append's line-count + delivery-id check. Every request is logged so a
// test can assert what was sent.
import type { PhantomBackend } from '../src/backend.js';

export interface FakeSession {
  id: string; workspaceId: string; folderId: string | null; status: string; agent: string | null;
  system_prompt: string[] | null; llm_config: unknown;
  lockedBy: string | null;
  lines: string[];
  lastDeliveryId: string | null;
  turnsEnded: number;
  backdoor: string[];
  planMode?: boolean;
  /** Events relayed to POST /sessions/:id/events, in order. */
  relayed: Record<string, unknown>[];
  /** Open GET /sessions/:id/events readers: push a line to all of them. */
  watchers: Set<(line: string) => void>;
}

export interface FakeRequest { method: string; path: string; body: unknown; headers: Record<string, string> }

export class FakeBackend {
  sessions = new Map<string, FakeSession>();
  requests: FakeRequest[] = [];
  tokenLog: unknown[] = [];
  /** What GET /agents/:kind/config answers. */
  agentConfig: unknown = {
    model: { provider: 'anthropic', model: 'claude-test', baseUrl: null, apiKey: 'sk-ant-api-test', reasoning: null },
    maxSteps: null,
    compaction: { thresholdPct: 80, contextWindow: 1000, summarizePct: 50, strategy: 'fast', maxTokens: null,
      model: { provider: 'openai', model: 'gpt-small', baseUrl: null, reasoning: null, apiKey: 'sk-openai-test' } },
  };
  settings: Record<string, { value: unknown }> = { timezone: { value: 'UTC' } };
  /** Fail the next N appends with this HTTP status (a flaky network). */
  failAppends = 0;
  /** Drop the RESPONSE of the next N appends after applying them (a lost reply). */
  loseAppendReplies = 0;
  private nextId = 1;

  readonly backend: PhantomBackend;

  constructor(clientId = 'test-client') {
    this.backend = { url: 'http://fake/api', apiKey: 'key', clientId, fetch: (input, init) => this.handle(input, init) };
  }

  newSession(overrides: Partial<FakeSession> = {}): FakeSession {
    const id = overrides.id ?? `s${this.nextId++}`;
    const s: FakeSession = {
      id, workspaceId: 'w1', folderId: 'f1', status: 'active', agent: null,
      system_prompt: null, llm_config: null, lockedBy: null, lines: [], lastDeliveryId: null,
      turnsEnded: 0, backdoor: [], relayed: [], watchers: new Set(),
      ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
    };
    this.sessions.set(id, s);
    return s;
  }

  private ok(data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } });
  }
  private err(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const path = url.pathname.replace(/^\/api/, '') + url.search;
    this.requests.push({ method, path, body, headers });
    const client = headers['x-phantom-looper-client'] ?? '';
    const p = url.pathname.replace(/^\/api/, '');
    const q = url.searchParams;

    let m: RegExpMatchArray | null;
    if (p === '/sessions' && method === 'POST') {
      const b = body as { workspace_id: string; id?: string };
      const existing = b.id ? this.sessions.get(b.id) : undefined;
      if (existing) { existing.status = 'active'; return this.ok(this.row(existing)); }
      return this.ok(this.row(this.newSession({ id: b.id, workspaceId: b.workspace_id })));
    }
    if (p === '/sessions/assistant' && method === 'POST') {
      const b = body as { workspace_id: string; session_id?: string };
      return this.ok(this.row(this.newSession({ workspaceId: b.workspace_id, agent: 'assistant', folderId: b.session_id ? 'f-of-' + b.session_id : null })));
    }
    if (p === '/sessions/supervisor' && method === 'POST') {
      const b = body as { workspace_id: string; folder_id: string };
      return this.ok(this.row(this.newSession({ workspaceId: b.workspace_id, agent: 'supervisor', folderId: b.folder_id })));
    }
    if ((m = p.match(/^\/sessions\/([^/]+)$/)) && method === 'GET') {
      const s = this.sessions.get(m[1]!);
      return s ? this.ok(this.row(s)) : this.err(404, 'session_not_found', `no session ${m[1]}`);
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/lock$/))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return this.err(404, 'session_not_found', 'no session');
      if (method === 'POST') {
        if (s.lockedBy && s.lockedBy !== client) return this.err(409, 'session_locked', `held by ${s.lockedBy}`);
        s.lockedBy = client; return this.ok({ locked: true });
      }
      if (method === 'DELETE') { if (s.lockedBy === client) s.lockedBy = null; return this.ok({ locked: false }); }
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/ping$/)) && method === 'POST') return this.ok({});
    if ((m = p.match(/^\/sessions\/([^/]+)\/frozen$/)) && method === 'PUT') {
      const s = this.sessions.get(m[1]!)!;
      if (s.lockedBy !== client) return this.err(409, 'session_locked', 'the freeze needs the lock');
      const b = body as { systemPrompt?: string[]; llmConfig?: unknown };
      if (b.systemPrompt) { if (s.system_prompt) return this.err(409, 'prompt_frozen', 'already frozen'); s.system_prompt = b.systemPrompt; }
      if (b.llmConfig) { if (s.llm_config) return this.err(409, 'prompt_frozen', 'already frozen'); s.llm_config = b.llmConfig; }
      return this.ok(this.row(s));
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/transcript$/)) && method === 'GET') {
      const s = this.sessions.get(m[1]!)!;
      return this.ok({ data: s.lines.length ? s.lines.join('\n') + '\n' : null, lines: s.lines.length });
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/transcript\/append$/)) && method === 'POST') {
      const s = this.sessions.get(m[1]!)!;
      if (this.failAppends > 0) { this.failAppends--; return this.err(503, 'unavailable', 'try later'); }
      if (s.lockedBy !== client) return this.err(409, 'session_locked', 'append needs the lock');
      const b = body as { after: number; deliveryId: string; lines: unknown[] };
      if (s.lastDeliveryId === b.deliveryId) return this.ok({ lines: s.lines.length, applied: false });
      if (s.lines.length !== b.after) return this.err(409, 'transcript_conflict', `have ${s.lines.length}, you said ${b.after}`);
      for (const l of b.lines) s.lines.push(JSON.stringify(l));
      s.lastDeliveryId = b.deliveryId;
      if (this.loseAppendReplies > 0) { this.loseAppendReplies--; throw new TypeError('fetch failed'); }
      return this.ok({ lines: s.lines.length, applied: true });
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/turn-ended$/)) && method === 'POST') {
      const s = this.sessions.get(m[1]!)!;
      if (s.lockedBy !== client) return this.err(409, 'session_locked', 'needs the lock');
      s.turnsEnded++; return this.ok({});
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/events$/)) && method === 'POST') {
      const s = this.sessions.get(m[1]!)!;
      if (s.lockedBy !== client) return this.err(409, 'session_locked', 'relay needs the lock');
      s.relayed.push(...(body as { events: Record<string, unknown>[] }).events);
      return this.ok({ published: true });
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/events$/)) && method === 'GET') {
      const s = this.sessions.get(m[1]!)!;
      const enc = new TextEncoder();
      let push: ((line: string) => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          push = (line) => controller.enqueue(enc.encode(line + '\n'));
          s.watchers.add(push);
          push(JSON.stringify({ event: 'lock', locked: true }));
        },
        cancel: () => { if (push) s.watchers.delete(push); },
      });
      init?.signal?.addEventListener('abort', () => { if (push) s.watchers.delete(push); });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/backdoor\/drain$/)) && method === 'POST') {
      const s = this.sessions.get(m[1]!)!;
      const messages = s.backdoor.splice(0);
      return this.ok({ messages });
    }
    if ((m = p.match(/^\/sessions\/([^/]+)\/follow$/)) && method === 'POST') {
      const s = this.sessions.get(m[1]!)!;
      const b = body as { session_id: string };
      s.folderId = 'f-of-' + b.session_id;
      return this.ok(this.row(s));
    }
    if (p.match(/^\/agents\/[^/]+\/config$/) && method === 'GET') return this.ok(this.agentConfig);
    if (p === '/log-tokens' && method === 'POST') { this.tokenLog.push(body); return this.ok({}); }
    if (p === '/settings' && method === 'GET') return this.ok(this.settings);
    if (p === '/skills' && method === 'GET') return this.ok({ skills: [{ name: 'deploy', description: 'How to deploy' }] });
    if (p === '/secrets' && method === 'GET') return this.ok({ secrets: [{ name: 'GH_TOKEN', description: 'GitHub' }] });
    if (p === '/tools' && method === 'GET') {
      return this.ok({ sessionHeader: 'x-phantom-looper-session', tools: [
        { name: 'read', summary: 'Read a file', input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, mutates: false },
        { name: 'bash', summary: 'Run a command', input: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }, mutates: true },
      ] });
    }
    if ((m = p.match(/^\/tools\/(\w+)$/)) && method === 'POST') {
      const b = body as { path?: string; cmd?: string };
      if (m[1] === 'read') {
        if (b.path === 'SOUL.md') return this.ok({ content: '     1\tI am the soul.' });
        return this.err(404, 'not_found', `${b.path}: no such file`);
      }
      return this.ok({ stdout: `ran ${b.cmd}` });
    }
    void q;
    return this.err(404, 'not_found', `no route ${method} ${p}`);
  }

  private row(s: FakeSession) {
    return { id: s.id, workspaceId: s.workspaceId, folderId: s.folderId, status: s.status, agent: s.agent,
      system_prompt: s.system_prompt, llm_config: s.llm_config, planMode: s.planMode ?? false };
  }

  /** Someone else stopped the turn: the feed carries it to every watcher. */
  publishInterrupt(id: string): void {
    for (const w of this.sessions.get(id)!.watchers) w(JSON.stringify({ event: 'interrupt' }));
  }

  /** The parsed lines of a session's transcript. */
  linesOf(id: string): Array<Record<string, unknown>> {
    return this.sessions.get(id)!.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
