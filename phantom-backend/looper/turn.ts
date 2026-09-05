// One coding turn, server-side — the shared runner under BOTH consumers
//: the looper's rounds and the POST /sessions/:id/turn
// route. A server-side turn is a normal session turn whose user message
// arrived as a string; the kits, the frozen prompt, and the record are the
// same parts every client uses.
import type { ModelMessage } from 'ai';
import type { OpenedSession } from '../../core/session.js';
import { memoryRecorder, serializeTranscript, type TranscriptHeader } from '../../core/llm/transcript.js';
import { buildCodingAgent, modelConfigFrom } from '../../core/llm/agentConfig.js';
import { withCacheBreakpoints } from '../../core/llm/createAgent.js';
import { phantomTools } from '../../core/llm/tools/workspace.js';
import { skillTools } from '../../core/llm/tools/skills.js';
import { webTools } from '../../core/llm/tools/web.js';
import { secretTools } from '../../core/llm/tools/secrets.js';
import { kanbanReadTool } from '../../core/llm/tools/kanban.js';
import { codingGitTools } from '../../core/llm/tools/git.js';
import type { SessionEvents } from '../api/sessionEvents.js';

export interface TurnDeps {
  f: typeof fetch;               // the server's own surface (injectFetch)
  apiKey: string;
  base: string;                  // host part the fetch shim ignores
  modelFetch?: typeof fetch;     // test seam → createAgent's fetch
  onRetry?: (note: string) => void;  // each failed model attempt, live
  /** The session's live feed. Every part of the turn is published here as it
   *  happens — the ONE place a coding turn's parts are published. Both
   *  consumers read it from there: watchers over GET /sessions/:id/events,
   *  and the turn route's own ND-JSON reply. */
  sessionEvents?: SessionEvents;
  /** The client id this turn holds the session under — stamped on every
   *  event it publishes, so the feed can keep a publisher from hearing
   *  itself. */
  client: string;
  /** Tools beyond the standard kits — the looper's `kanban_card_block`,
   *  bound to the run's card. A manual turn (the /turn route) passes none:
   *  the block tool's description talks about a run it is not in. */
  extraTools?: Record<string, import('ai').Tool>;
}

/** The resolved settings as plain values — the same rows every client reads,
 *  credentials decrypted, over the same route. */
export async function settingsValues(deps: TurnDeps): Promise<Record<string, unknown>> {
  const r = await deps.f(`${deps.base}/settings`, {
    headers: { authorization: `Bearer ${deps.apiKey}` } });
  const j = await r.json() as { ok: boolean; data: Record<string, { value: unknown }> };
  if (!j.ok) throw new Error('could not read settings');
  return Object.fromEntries(Object.entries(j.data).map(([k, v]) => [k, v.value]));
}

/** Run one coding turn on an opened session and save the record whole. Plan
 *  mode = the readonly preset on the mutating kits (extraTools ride outside
 *  the preset — the loop's block tool works while planning by design).
 *  The turn always STREAMS, whether or not anyone is watching: one code path
 *  for both consumers, and the record it saves is identical either way
 *  (createAgent's `record` seam collects the same steps from stream and
 *  generate alike). Returns the reply text and the turn's token spend
 *  (input + output). */
export async function runCodingTurn(
  deps: TurnDeps, opened: OpenedSession, workspaceId: string,
  message: string, planMode: boolean, cfg?: Record<string, unknown>,
): Promise<{ text: string; tokens: number }> {
  const values = cfg ?? await settingsValues(deps);
  const pick = planMode ? ('readonly' as const) : undefined;
  const common = { baseUrl: deps.base, apiKey: deps.apiKey, sessionId: opened.session.id, fetch: deps.f };
  const tools = {
    ...await phantomTools({ ...common, pick }),
    ...skillTools({ ...common, pick }),
    ...webTools(common),
    ...secretTools({ baseUrl: deps.base, apiKey: deps.apiKey, workspaceId, fetch: deps.f }),
    ...kanbanReadTool({ baseUrl: deps.base, apiKey: deps.apiKey, workspaceId, fetch: deps.f }),
    ...codingGitTools({ ...common, pick, clientId: deps.client }),
    ...deps.extraTools,
  };
  const model = modelConfigFrom(values);
  const { agent } = buildCodingAgent(values, tools, opened.instructions, deps.modelFetch, deps.onRetry);
  const messages: ModelMessage[] = [...opened.messages, { role: 'user', content: message }];

  // The cache marks ride copies (withCacheBreakpoints); `messages` itself is
  // what the transcript records and must stay clean. `record` is createAgent's
  // step seam: each step's messages and usage line collect here for the
  // turn-end save — the WHOLE turn, where the SDK's turn-end response
  // carries only the final step.
  const marked = withCacheBreakpoints(messages);
  const { record, events: turnEvents, messages: turnMessages } = memoryRecorder(messages.length);
  const feed = deps.sessionEvents;
  const id = opened.session.id;
  let text = '';
  feed?.publish(id, deps.client, { event: 'turn-start', agent: 'coding', message });
  try {
    const r = await agent.stream({ messages: marked, record });
    await drain(r, (part) => {
      const p = part as { type: string; text?: string };
      if (p.type === 'text-delta' && p.text) text += p.text;
      feed?.publishPart(id, deps.client, part);
    });
  } catch (e) {
    // A watcher must see a turn fail, not just stop. The throw still travels:
    // the route answers with its error line, the looper blocks the card.
    feed?.publish(id, deps.client, { event: 'error', message: (e as Error).message });
    throw e;
  } finally {
    feed?.publish(id, deps.client, { event: 'turn-end' });
  }

  const header: TranscriptHeader = opened.header ?? {
    type: 'session', agent: 'coding', provider: model.provider, model: model.model,
    created_at: new Date().toISOString(), system_prompt: opened.instructions,
    session_id: opened.session.id, workspace: workspaceId, branch: opened.session.branch,
  };
  await opened.saveTranscript(serializeTranscript(header,
    [...messages, ...turnMessages],
    [...opened.events, ...turnEvents]));
  return { text, tokens: sumTokens(turnEvents) };
}

/** Read a turn's stream to the end, handing every part to `onPart`, and
 *  settle it. A failure inside the stream arrives as an `error` PART, and the
 *  turn's promise then rejects with the SDK's generic "no output generated"
 *  — so the part is what carries the reason (a 401's "invalid x-api-key", a
 *  provider's message). That reason is what gets thrown: it is what blocks
 *  the card and what the board shows. */
export async function drain(
  r: { stream: AsyncIterable<unknown>; response: PromiseLike<unknown> }, onPart: (part: unknown) => void,
): Promise<void> {
  let failure: unknown;
  for await (const part of r.stream) {
    const p = part as { type: string; error?: unknown };
    if (p.type === 'error' && failure === undefined) failure = p.error;
    onPart(part);
  }
  if (failure !== undefined) {
    Promise.resolve(r.response).catch(() => { /* the same failure, already in hand */ });
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  await r.response;
}

/** input + output tokens across a turn's usage lines — the budget's coin
 *  (cache traffic deliberately free). */
export function sumTokens(events: { event: Record<string, unknown> }[]): number {
  let n = 0;
  for (const { event } of events) {
    if (event.type !== 'usage') continue;
    for (const k of ['input', 'output'] as const) {
      const v = event[k];
      if (typeof v === 'number' && Number.isFinite(v)) n += v;
    }
  }
  return n;
}
