// core/llm/createAgent: what goes on the wire, without a network. A capturing
// fetch records the request the provider client builds and then fails it, so
// every assertion is about headers and body — the subscription-token disguise,
// the thinking rule, the provider switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgent, effectiveReasoning, isAnthropicOAuth, withClaudeCodeIdentity, CLAUDE_CODE_SYSTEM,
  languageModel, thinkingAlwaysOn, type ModelConfig,
} from '../core/llm/createAgent.js';

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A fetch that records the request and fails it (nothing leaves the process). */
function capture(): { fetch: typeof fetch; last: () => Captured } {
  const seen: Captured[] = [];
  const f: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    seen.push({ url: String(input), headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
    throw new Error('captured');
  };
  return { fetch: f, last: () => { const c = seen.at(-1); if (!c) throw new Error('nothing captured'); return c; } };
}

async function request(c: Omit<ModelConfig, 'fetch'>, instructions = 'be brief'): Promise<Captured> {
  const cap = capture();
  const agent = createAgent({ ...c, fetch: cap.fetch }, { instructions, tools: {}, maxSteps: 1 });
  await agent.generate({ prompt: 'hi' }).then(() => { throw new Error('should have failed'); }, () => undefined);
  return cap.last();
}

test('isAnthropicOAuth: OAuth tokens yes, Console keys and junk no', () => {
  assert.equal(isAnthropicOAuth('sk-ant-oat01-abc'), true);
  assert.equal(isAnthropicOAuth('sk-ant-sid01-abc'), true);
  assert.equal(isAnthropicOAuth('sk-ant-api03-abc'), false);
  assert.equal(isAnthropicOAuth('sk-proj-openai'), false);
  assert.equal(isAnthropicOAuth(undefined), false);
  assert.equal(isAnthropicOAuth(null), false);
});

test('withClaudeCodeIdentity: first block, every shape, idempotent', () => {
  assert.deepEqual(withClaudeCodeIdentity(undefined), [{ type: 'text', text: CLAUDE_CODE_SYSTEM }]);
  assert.deepEqual(withClaudeCodeIdentity('mine'), [{ type: 'text', text: CLAUDE_CODE_SYSTEM }, { type: 'text', text: 'mine' }]);
  assert.deepEqual(withClaudeCodeIdentity(''), [{ type: 'text', text: CLAUDE_CODE_SYSTEM }]);
  const blocks = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  const once = withClaudeCodeIdentity(blocks);
  assert.equal(once.length, 3); assert.equal(once[0].text, CLAUDE_CODE_SYSTEM);
  assert.equal(withClaudeCodeIdentity(once), once, 'already first: returned as-is');
});

test('thinking rule: only fable cannot stop thinking; none→minimal there, untouched elsewhere', () => {
  assert.equal(thinkingAlwaysOn('claude-fable-5'), true);
  assert.equal(thinkingAlwaysOn('claude-opus-5'), false);
  assert.equal(thinkingAlwaysOn('claude-haiku-4-5'), false);
  assert.equal(effectiveReasoning('anthropic', 'claude-fable-5', 'none'), 'minimal');
  assert.equal(effectiveReasoning('anthropic', 'claude-fable-5', 'high'), 'high');
  assert.equal(effectiveReasoning('anthropic', 'claude-haiku-4-5', 'none'), 'none');
  assert.equal(effectiveReasoning('openai', 'claude-fable-5', 'none'), 'none', 'an id on another provider is not Claude');
  assert.equal(effectiveReasoning('anthropic', 'claude-fable-5', undefined), undefined);
});

test('anthropic API key: x-api-key, our instructions are the system prompt, none = thinking disabled', async () => {
  const r = await request({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-api03-k', reasoning: 'none' });
  assert.match(r.url, /api\.anthropic\.com\/v1\/messages/);
  assert.equal(r.headers['x-api-key'], 'sk-ant-api03-k');
  assert.equal(r.headers['authorization'], undefined);
  assert.equal(r.body.model, 'claude-haiku-4-5');
  const system = r.body.system as Array<{ text: string }> | string;
  assert.equal(typeof system === 'string' ? system : system[0].text, 'be brief');
  assert.deepEqual(r.body.thinking, { type: 'disabled' });
});

test('anthropic subscription token: Bearer, CLI headers, identity block first, no x-api-key', async () => {
  const r = await request({ provider: 'anthropic', model: 'claude-fable-5', apiKey: 'sk-ant-oat01-t', reasoning: 'medium' });
  assert.equal(r.headers['authorization'], 'Bearer sk-ant-oat01-t');
  assert.equal(r.headers['x-api-key'], undefined, 'Bearer + x-api-key together is a 401');
  assert.match(r.headers['anthropic-beta'] ?? '', /oauth-2025-04-20/);
  assert.equal(r.headers['x-app'], 'cli');
  const system = r.body.system as Array<{ text: string }>;
  assert.equal(system[0].text, CLAUDE_CODE_SYSTEM);
  assert.equal(system[1].text, 'be brief');
});

test('fable + none goes out as adaptive thinking at effort low (disabled would be a 400)', async () => {
  const r = await request({ provider: 'anthropic', model: 'claude-fable-5', apiKey: 'sk-ant-api03-k', reasoning: 'none' });
  assert.deepEqual(r.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(r.body.output_config, { effort: 'low' });
});

test('no reasoning given: nothing about thinking is sent', async () => {
  const r = await request({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-k' });
  assert.equal(r.body.thinking, undefined);
  assert.equal(r.body.output_config, undefined);
});

test('openai and openai-compatible: bearer key, the base url is honoured; compatible without one is refused', async () => {
  const o = await request({ provider: 'openai', model: 'gpt-5-mini', apiKey: 'sk-o' });
  assert.match(o.url, /api\.openai\.com/);
  assert.equal(o.headers['authorization'], 'Bearer sk-o');
  const c = await request({ provider: 'openai-compatible', model: 'local', apiKey: null, baseUrl: 'http://localhost:11434/v1' });
  assert.match(c.url, /^http:\/\/localhost:11434\/v1\//);
  assert.throws(() => languageModel({ provider: 'openai-compatible', model: 'x' }), /base url/);
});

test('google: the key rides as a header, not in the url', async () => {
  const g = await request({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'g-k' });
  assert.match(g.url, /generativelanguage\.googleapis\.com/);
  assert.ok(g.headers['x-goog-api-key'] === 'g-k' || g.url.includes('key=g-k'), 'the key is sent');
});

// ── the prompt stack and the tool kits (core/llm/prompts, tools, agents) ─────

import { fill, firstLineOf } from '../core/llm/prompts/template.js';
import { firstLine, toCodingAgent, toSupervisor } from '../core/llm/prompts/supervisor/wiring.js';
import { codingInstructions } from '../core/llm/agents/coding.js';
import { withCurrentDate } from '../core/llm/prompts/template.js';
import { assistantInstructions } from '../core/llm/agents/assistant.js';
import { gitFixerInstructions, toGitFixer } from '../core/llm/agents/gitFixer.js';
import { pickTools, phantomTools } from '../core/llm/tools/workspace.js';
import { fixerBashTool } from '../core/llm/tools/server.js';
import { sessionsTool, assistantKanbanTool, codingKanbanTool, renderRead } from '../core/llm/tools/tui.js';
import type { Tool } from 'ai';

test('fill: blanks substitute in place; an empty value drops its whole line; a missing one is loud', () => {
  assert.equal(fill('A\n\n{{x}}\n\nB', { x: 'X' }), 'A\n\nX\n\nB');
  assert.equal(fill('A\n\n{{x}}\n\nB', { x: '' }), 'A\n\nB', 'an empty blank leaves no gap');
  assert.equal(fill('A\n\nLabel: {{x}}\n\nB', { x: '' }), 'A\n\nB', 'the label goes with it');
  assert.equal(fill('A\n\n{{x}}', { x: '' }), 'A', 'an empty trailing blank leaves no tail');
  assert.throws(() => fill('A {{x}}', {}), /blank \{x\} has no value/);
  assert.equal(fill('The card:\n{{card}}', { card: '{"a":1}' }), 'The card:\n{"a":1}',
    'braces inside a value are never re-scanned');
});

test('fill: whitespace at the edges of a template or a value never reaches the prompt', () => {
  assert.equal(fill('\n\nA\n\n{{block}}\n\nB\n\n', { block: '\n\nX\n\nY\n\n' }), 'A\n\nX\n\nY\n\nB',
    'edge blank lines are stripped once, here; spacing inside the value is verbatim');
  assert.equal(fill('A\n\n{{x}}\n\nB', { x: '\n\n' }), 'A\n\nB', 'a value that is only whitespace is empty');
  assert.equal(firstLineOf('\n\nCard {{seq}} is here.\n\nmore', { seq: 7 }), 'Card 7 is here.',
    'the marker is the first line that would be SENT, blank-line opener or not');
});

test("every fixed loop message starts with its own frozen first line — the looper's marker can never miss", () => {
  const card = { seq: 7, title: 't', status: 'plan', user_story: 'u', details: 'd',
    requirements: [{ key: 'k1', text: 'r', done: false }], resolution: 'because' };
  const pairs: [string, string][] = [
    [toCodingAgent.planCard(card), firstLine.planCard(7)],
    [toCodingAgent.buildFromPlan(card), firstLine.buildFromPlan(7)],
    [toCodingAgent.buildFromCard(card), firstLine.buildFromCard(7)],
    [toCodingAgent.cardIsBack(card), firstLine.cardIsBack(7)],
    [toSupervisor.reviewingPlan(card), firstLine.reviewingPlan(7)],
    [toSupervisor.reviewingWork(card, { planned: false }), firstLine.reviewingWork(7)],
  ];
  for (const [sent, marker] of pairs) {
    assert.ok(marker.length > 0, 'a marker is never empty');
    assert.ok(sent.startsWith(marker), `sent text starts with its marker: ${marker}`);
    assert.ok(!/\n{3,}/.test(sent), 'no run of blank lines in an emitted message');
  }
  assert.equal(new Set(pairs.map(([, m]) => m)).size, pairs.length, 'markers are unique');
});

test('coding agent prompt: identity frozen; no time in the frozen text; date appended outside', () => {
  const p = codingInstructions();
  assert.equal(codingInstructions(), p, 'byte-stable (prompt caching)');
  assert.match(p, /value-based coding agent/);
  assert.match(p, /\/workspace\/repo \(your cwd\) is your working project's files/);
  assert.match(p, /\/workspace\/scratch is your scratch pad/);
  assert.doesNotMatch(p, /session started|\d:\d\d|AM|PM/, 'Shockwave rule: no clock time anywhere in a prompt');
  assert.doesNotMatch(p, /Current date/, 'the frozen text never carries the current date');
  const dated = withCurrentDate(p, new Date(2026, 7, 24));
  assert.ok(dated.startsWith(p), 'the date is appended below, the frozen part is untouched');
  assert.match(dated, /Current date: August 24, 2026\./);
});

test('coding agent prompt: the git fact is static; the credential fact is settings-fed, SILENT when off', () => {
  const on = codingInstructions([], { credentials: true });
  assert.match(on, /Git operations are normally covered for you/);
  assert.match(on, /GitHub token is in your environment \(GITHUB_TOKEN\)/);
  assert.doesNotMatch(on, /do not use git/, 'facts, not instructions');
  const off = codingInstructions([], { credentials: false });
  assert.match(off, /Git operations are normally covered/, 'the git fact does not depend on a setting');
  assert.doesNotMatch(off, /GITHUB_TOKEN/, 'off says nothing');
  assert.match(off, /\/workspace\/scratch is your scratch pad/, 'the scratch fact stays');
  assert.equal(codingInstructions(), off, 'no facts = the credential line silent, same as off');
});

test('coding agent prompt: the skills index — between coding and the workspace facts, clipped, mandatory; empty = absent', () => {
  const skills = [
    { name: 'deploy-checks', description: 'Use when deploying. Run the release checklist end to end.' },
    { name: 'pdf-tools', description: 'x'.repeat(80) },
  ];
  const p = codingInstructions(skills);
  assert.match(p, /- deploy-checks: Use when deploying\. Run the release checklist end/);
  assert.match(p, new RegExp(`- pdf-tools: ${'x'.repeat(57)}\\.\\.\\.`), 'descriptions clip at 60 (57 + …)');
  assert.match(p, /skill_load tool loads a skill by name/, 'the tools are described, not commanded');
  assert.match(p, /skill_list tool returns the skill list/, 'the frozen index points at the live view');
  assert.ok(p.indexOf('deploy-checks') > p.indexOf('/workspace/repo'), 'after the coding sections');
  assert.ok(p.indexOf('deploy-checks') < p.indexOf('Git operations are normally covered'), 'before the workspace facts');
  assert.equal(codingInstructions([]), codingInstructions(), 'no skills = the plain stack, byte-stable');
  assert.doesNotMatch(codingInstructions(), /skill_load/, 'no empty skills section');
});

test('coding agent prompt: the secrets index — names + descriptions, never values; clipped; empty = absent', () => {
  const secrets = [
    { name: 'stripe_key', description: 'Stripe live key for the payments service.' },
    { name: 'deploy_token', description: 'y'.repeat(80) },
  ];
  const p = codingInstructions([], undefined, secrets);
  assert.match(p, /stored secrets for your use/, 'the section announces itself');
  assert.match(p, /kept encrypted on the server/, 'says where the values live — not here');
  assert.match(p, /- stripe_key: Stripe live key for the payments service\./);
  assert.match(p, new RegExp(`- deploy_token: ${'y'.repeat(57)}\\.\\.\\.`), 'descriptions clip at 60, like skills');
  assert.match(p, /secret_get tool returns a value by name/, 'the tool is described, not commanded');
  assert.match(p, /secret_list tool returns the most current list/, 'the frozen index points at the live view');
  assert.ok(p.indexOf('stripe_key') < p.indexOf('Git operations are normally covered'), 'before the workspace facts');
  assert.equal(codingInstructions([], undefined, []), codingInstructions(), 'no secrets = the plain stack, byte-stable');
  assert.doesNotMatch(codingInstructions(), /secret_get/, 'no empty secrets section');
});

test('coding agent prompt: the environment block always stands; the facts line is dynamic; empty = line absent', () => {
  const facts = 'Debian GNU/Linux 13 (trixie), arm64 · Node v24.5.0 · Python 3.13.5';
  const p = codingInstructions([], undefined, [], facts);
  assert.match(p, /file and bash tools run in a Linux container/);
  assert.match(p, /Debian GNU\/Linux 13 \(trixie\), arm64 · Node v24\.5\.0 · Python 3\.13\.5/);
  assert.match(p, /passwordless sudo/, 'the static text rides with the facts');
  assert.match(p, /permission before deleting/, 'the delete-permission rule is in');
  assert.ok(p.indexOf('Linux container') < p.indexOf('/workspace/repo'), 'before the workspace facts');
  const bare = codingInstructions();
  assert.match(bare, /passwordless sudo/, 'no facts = the static block still stands');
  assert.doesNotMatch(bare, /Debian/, 'no facts = no version line');
  assert.equal(codingInstructions([], undefined, [], ''), bare, 'empty facts = the plain stack, byte-stable');
});

test('secrets kit: read-only pair on /secrets, workspace-bound at build; get is by name', async () => {
  const { secretTools } = await import('../core/llm/tools/secrets.js');
  const seen: string[] = [];
  const answers: Record<string, unknown> = {
    '/secrets?workspace=w1': { ok: true, data: { secrets: [
      { name: 'stripe_key', description: 'Stripe live key', scope: 'global' }] } },
    '/secrets/stripe_key?workspace=w1': { ok: true, data: { name: 'stripe_key', value: 'sk_live_x' } },
  };
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const path = url.replace('http://x', '');
    seen.push(path);
    assert.equal(init?.headers?.authorization, 'Bearer k');
    return new Response(JSON.stringify(answers[path]));
  }) as unknown as typeof fetch;
  const kit = secretTools({ baseUrl: 'http://x', apiKey: 'k', workspaceId: 'w1', fetch: f });
  assert.deepEqual(Object.keys(kit), ['secret_list', 'secret_get'], 'list + get, nothing that writes');
  const run = (name: string, a: unknown) =>
    (kit[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(a, { toolCallId: 't', messages: [] });

  const l = await run('secret_list', {}) as { secrets: Array<{ name: string }> };
  assert.equal(l.secrets[0].name, 'stripe_key');
  const g = await run('secret_get', { name: 'stripe_key' }) as { ok: boolean; data: { value: string } };
  assert.equal(g.data.value, 'sk_live_x', 'the envelope is the tool result, value included');
  assert.deepEqual(seen, ['/secrets?workspace=w1', '/secrets/stripe_key?workspace=w1'],
    'both calls carry the bound workspace — its secrets shadow global by name');
  // The descriptions carry what the frozen prompt cannot reach mid-session:
  // list is the live view, get returns real values to use directly.
  assert.match(String((kit.secret_list as { description?: string }).description), /added since/);
  assert.match(String((kit.secret_get as { description?: string }).description), /never invent a placeholder/);
});

test('assistant prompt: spoken register, tools; no clock time', () => {
  const p = assistantInstructions();
  assert.match(p, /the Assistant inside phantom-looper/);
  assert.match(p, /replies are read aloud/);
  assert.match(p, /Never use markdown of any kind/);
  assert.match(p, /No pleasantries, no preamble/);
  assert.match(p, /Never assume you know the state of the UI/);
  assert.match(p, /Stakeholders involved/, 'who is who');
  assert.match(p, /Simplicity is the wall/, 'the shared values');
  assert.match(p, /auto-push/, 'the git workflow, so it can point at the action');
  assert.doesNotMatch(p, /the user can open/, 'one name per stakeholder — the person talking is the builder');
  assert.match(p, /Cards go by number/);
  assert.doesNotMatch(p, /session started|AM|PM/);
});

test('git fixer prompt: branch pinned, no aborting, the trailer, the tool named as it exists', () => {
  const p = gitFixerInstructions('agent/s1', 's1');
  assert.match(p, /checked out on branch "agent\/s1"/);
  assert.match(p, /never run checkout, switch, branch, or reset --hard/);
  assert.match(p, /Do NOT run `git merge --abort`/);
  assert.match(p, /Phantom-Session: s1/);
  assert.match(p, /Use bash to inspect/, 'the prompt names the tool the agent actually has');
  assert.match(toGitFixer.recover('agent/s1'), /Recover branch "agent\/s1"/);
});

const LISTING = [
  { name: 'bash', mutates: true }, { name: 'read', mutates: false }, { name: 'write', mutates: true },
  { name: 'edit', mutates: true }, { name: 'ls', mutates: false }, { name: 'find', mutates: false },
  { name: 'grep', mutates: false },
];

test('workspace kit: pick by name, pick readonly, an unknown name is loud', () => {
  assert.deepEqual(pickTools(LISTING).map((t) => t.name), LISTING.map((t) => t.name), 'no pick = the whole kit');
  assert.deepEqual(pickTools(LISTING, 'readonly').map((t) => t.name), ['read', 'ls', 'find', 'grep']);
  assert.deepEqual(pickTools(LISTING, ['read', 'grep']).map((t) => t.name), ['read', 'grep']);
  assert.throws(() => pickTools(LISTING, ['read', 'gerp']), /unknown tool\(s\): gerp/);
});

test('workspace kit end to end: pick reaches the derived tool set', async () => {
  const listing = {
    sessionHeader: 'x-phantom-looper-session',
    tools: LISTING.map((t) => ({ ...t, summary: t.name, input: { type: 'object', properties: {} } })),
  };
  const f: typeof fetch = async () => new Response(JSON.stringify({ data: listing }), { status: 200 });
  const all = await phantomTools({ baseUrl: 'http://x', apiKey: 'k', sessionId: 's', fetch: f });
  assert.deepEqual(Object.keys(all), ['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep']);
  const ro = await phantomTools({ baseUrl: 'http://x', apiKey: 'k', sessionId: 's', fetch: f, pick: 'readonly' });
  assert.deepEqual(Object.keys(ro), ['read', 'ls', 'find', 'grep']);
});

test('workspace kit: the SDK abort signal rides into the tool fetch — esc reaches the server', async () => {
  const listing = {
    sessionHeader: 'x-phantom-looper-session',
    tools: LISTING.map((t) => ({ ...t, summary: t.name, input: { type: 'object', properties: {} } })),
  };
  const seen: Array<AbortSignal | null | undefined> = [];
  const f: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/tools')) return new Response(JSON.stringify({ data: listing }), { status: 200 });
    seen.push(init?.signal);
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  };
  const kit = await phantomTools({ baseUrl: 'http://x', apiKey: 'k', sessionId: 's', fetch: f });
  const ac = new AbortController();
  await (kit.bash as { execute: (a: unknown, o: unknown) => Promise<unknown> })
    .execute({ cmd: 'sleep 1' }, { toolCallId: 't', messages: [], abortSignal: ac.signal });
  assert.equal(seen[0], ac.signal, 'the tool POST carries the signal the SDK handed execute');
});

test('server kit: the fixer bash tool runs one command and truncates its output', async () => {
  const seen: string[] = [];
  const kit = fixerBashTool(async (cmd) => { seen.push(cmd); return { stdout: 'y'.repeat(9000), stderr: '', exitCode: 0 }; });
  assert.deepEqual(Object.keys(kit), ['bash']);
  const r = await (kit.bash as { execute: (a: unknown, o: unknown) => Promise<{ stdout: string; exitCode: number }> })
    .execute({ cmd: 'git status' }, { toolCallId: 't', messages: [] });
  assert.deepEqual(seen, ['git status']);
  assert.equal(r.stdout.length, 8000, 'stdout truncated');
  assert.equal(r.exitCode, 0);
});

test('skills kit: list rides /skills (tiers merge server-side), load dedups an unchanged repeat, manage POSTs the body', async () => {
  const { skillTools } = await import('../core/llm/tools/skills.js');
  const seen: { url: string; method: string; body?: unknown }[] = [];
  const answers: Record<string, unknown> = {
    'GET /skills': { ok: true, data: { skills: [{ name: 'deploy', description: 'repo tier' }] } },
    'GET /skills/deploy': { ok: true, data: { name: 'deploy', instructions: 'STEPS', files: ['references/a.md'] } },
    'POST /skills': { ok: true, data: { message: "Skill 'x' created." } },
  };
  const f = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('http://x', '').replace(/\?.*$/, '');
    seen.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    assert.equal(init?.headers?.['x-phantom-looper-session'], 's1', 'the session rides the header');
    return new Response(JSON.stringify(answers[`${method} ${path}`] ?? { ok: false, error: { code: 'skill_not_found', message: 'no' } }));
  }) as unknown as typeof fetch;
  const kit = skillTools({ baseUrl: 'http://x', apiKey: 'k', sessionId: 's1', fetch: f });
  assert.deepEqual(Object.keys(kit), ['skill_list', 'skill_load', 'skill_manage']);
  const run = (name: string, a: unknown) =>
    (kit[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(a, { toolCallId: 't', messages: [] });

  assert.deepEqual(await run('skill_list', {}), { skills: [{ name: 'deploy', description: 'repo tier' }] });
  const first = await run('skill_load', { name: 'deploy' }) as { instructions: string };
  assert.equal(first.instructions, 'STEPS', 'the whole body + bundled file names in one call');
  const again = await run('skill_load', { name: 'deploy' }) as { note?: string };
  assert.match(String(again.note), /unchanged since it was loaded earlier/, 'hermes\'s dedup stub');
  const missing = await run('skill_load', { name: 'nope' }) as { ok: boolean };
  assert.equal(missing.ok, false, 'the server\'s error envelope stands');
  await run('skill_manage', { action: 'create', name: 'x', content: 'c' });
  const post = seen.find((s) => s.method === 'POST');
  assert.deepEqual(post?.body, { action: 'create', name: 'x', content: 'c' });
});

test('web kit: thin clients on /web — session in the header, envelope back verbatim', async () => {
  const { webTools } = await import('../core/llm/tools/web.js');
  const seen: { path: string; body: unknown }[] = [];
  const answers: Record<string, unknown> = {
    '/web/search': { ok: true, data: [{ title: 'T', url: 'http://u', snippet: 's' }] },
    '/web/fetch': { ok: true, data: [{ url: 'http://u', status_code: 200, path: '/workspace/web/u.md', title: 'T', bytes: 5 }] },
  };
  const f = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const path = url.replace('http://x', '');
    seen.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    assert.equal(init?.headers?.['x-phantom-looper-session'], 's1', 'the session rides the header');
    assert.equal(init?.headers?.authorization, 'Bearer k');
    return new Response(JSON.stringify(answers[path]));
  }) as unknown as typeof fetch;
  const kit = webTools({ baseUrl: 'http://x', apiKey: 'k', sessionId: 's1', fetch: f });
  assert.deepEqual(Object.keys(kit), ['web_search', 'web_fetch']);
  const run = (name: string, a: unknown) =>
    (kit[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(a, { toolCallId: 't', messages: [] });

  const s = await run('web_search', { query: 'q', limit: 5 }) as { ok: boolean };
  assert.equal(s.ok, true, 'the envelope is the tool result, untouched');
  assert.deepEqual(seen[0], { path: '/web/search', body: { query: 'q', limit: 5 } });
  await run('web_fetch', { urls: ['http://u'] });
  assert.deepEqual(seen[1], { path: '/web/fetch', body: { urls: ['http://u'] } });
  // The descriptions carry the two usage rules the frozen prompt cannot:
  // snippets often suffice, and URLs batch into ONE parallel call.
  assert.match(String((kit.web_search as { description?: string }).description), /often enough/);
  assert.match(String((kit.web_fetch as { description?: string }).description), /all URLs in one call/);
});

test('tui kit: the session_* family — each tool passes its fixed action to the one handler', async () => {
  const calls: unknown[] = [];
  const kit = sessionsTool(async (args) => { calls.push(args); return { ok: true }; });
  assert.deepEqual(Object.keys(kit), ['session_list', 'session_get_active', 'session_switch', 'session_read', 'session_close']);
  const run = (name: string, a: unknown) =>
    (kit[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> })
      .execute(a, { toolCallId: 't', messages: [] });
  const r = await run('session_list', {});
  // list pages the same way read does — the paging words are one convention
  // across the kit, and they reach the handler untouched.
  await run('session_list', { limit: 5, offset: 20 });
  await run('session_switch', { id: 's2' });
  await run('session_read', { limit: 5 });
  // get_active takes no arguments: what is on screen is the window's fact,
  // never something the model names.
  await run('session_get_active', {});
  // close: by id, or the active session when the id is left out.
  await run('session_close', { id: 's2' });
  await run('session_close', {});
  assert.deepEqual(calls, [
    { action: 'list' },
    { action: 'list', limit: 5, offset: 20 },
    { action: 'switch', id: 's2' },
    { action: 'read', limit: 5 },
    { action: 'get_active' },
    { action: 'close', id: 's2' },
    { action: 'close', id: undefined },
  ]);
  assert.deepEqual(r, { ok: true });
});

test('sessions read: the compact view — text whole, tools one line, header says which slice', () => {
  const big = 'x'.repeat(2000);
  const messages = [
    { role: 'user', content: 'fix the failing board test' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'let me think about this' },
      { type: 'text', text: 'Looking at the test first.' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { command: 'npm test' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'bash', output: { type: 'text', value: `194 tests, 2 failed\n${big}` } },
    ] },
    { role: 'assistant', content: 'Done — both tests pass now.' },
  ] as never[];

  const out = renderRead('s1', messages);
  assert.match(out, /^session s1 — showing 1-4 of 4 · oldest first\n/);
  assert.match(out, /user: fix the failing board test/);
  assert.match(out, /assistant: Looking at the test first\./);
  assert.match(out, /ran bash: npm test/, 'a tool call is one line: name + main argument');
  assert.match(out, /result \(2\.0kb\): 194 tests, 2 failed x+…/, 'a tool result is one line + size');
  assert.ok(!out.includes(big), 'the body stays out by default');
  assert.ok(!out.includes('let me think'), 'thinking is dropped');
  const order = ['user:', 'Looking at', 'ran bash', 'result', 'Done'].map((s) => out.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'oldest first, newest last');

  // tools: true = the whole output.
  assert.ok(renderRead('s1', messages, { tools: true }).includes(big));

  // limit/offset page backwards from the most recent; the header owns the math.
  assert.match(renderRead('s1', messages, { limit: 2 }), /showing 3-4 of 4/);
  assert.match(renderRead('s1', messages, { limit: 2, offset: 2 }), /showing 1-2 of 4/);
  assert.match(renderRead('s1', messages, { limit: 2, offset: 3 }), /showing 1-1 of 4/, 'clamped, never negative');
  assert.match(renderRead('s1', messages, { offset: 9 }), /showing none of 4/);
});

test('tui kit: the coding agent reads cards and nothing else; the Assistant keeps the full board', async () => {
  const calls: unknown[] = [];
  const kit = codingKanbanTool(async (args) => { calls.push(args); return { ok: true }; });
  assert.deepEqual(Object.keys(kit), ['kanban_card_read'],
    'one tool — the kit defines what the agent can do; the looper adds kanban_card_block inside a run');
  const desc = (t: Record<string, Tool>, n: string) => String((t[n] as { description: string }).description);
  assert.match(desc(kit, 'kanban_card_read'), /source of truth/, 're-read on retry lives in the description');
  assert.doesNotMatch(desc(kit, 'kanban_card_read'), /read-only/,
    'no lecture about absent powers — tools describe themselves, not what is missing');
  await (kit.kanban_card_read as { execute: (a: unknown, o: unknown) => Promise<unknown> })
    .execute({ card: 7 }, { toolCallId: 't', messages: [] });
  assert.deepEqual(calls, [{ action: 'read', card: 7 }]);

  // The Assistant keeps the whole board — cards plus the screen. One board,
  // two jobs.
  const acalls: unknown[] = [];
  const assistant = assistantKanbanTool(async (args) => { acalls.push(args); return { ok: true }; });
  assert.deepEqual(Object.keys(assistant), [
    'kanban_screen',
    'kanban_card_list', 'kanban_card_read', 'kanban_card_create', 'kanban_card_update', 'kanban_card_items',
    'kanban_card_auto_plan', 'kanban_card_auto_build', 'kanban_card_pin', 'kanban_card_move', 'kanban_card_history',
  ]);
  assert.match(desc(assistant, 'kanban_card_items'), /there is no whole-list send/i);
  assert.match(desc(assistant, 'kanban_card_update'), /kanban_card_items/);
  // The two looper switches: on/off/inherit maps onto the card's tri-state —
  // inherit is null (clear the override), never a stored third value.
  assert.match(desc(assistant, 'kanban_card_auto_plan'), /plan/);
  assert.match(desc(assistant, 'kanban_card_auto_build'), /in_progress/);
  const run = (name: string, a: unknown) => (assistant[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> })
    .execute(a, { toolCallId: 't', messages: [] });
  await run('kanban_card_auto_plan', { card: 7, state: 'on' });
  await run('kanban_card_auto_build', { card: 7, state: 'inherit' });
  // The pin is a plain on/off — no inherit, no looper meaning.
  await run('kanban_card_pin', { card: 7, state: 'on' });
  await run('kanban_card_pin', { card: 7, state: 'off' });
  assert.deepEqual(acalls, [
    { action: 'update', card: 7, auto_plan: true },
    { action: 'update', card: 7, auto_build: null },
    { action: 'update', card: 7, pinned: true },
    { action: 'update', card: 7, pinned: false },
  ]);
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transcript, loadTranscriptFile } from '../core/llm/transcript.js';
import { runGitFixer, type GitFixerDriver } from '../phantom-backend/git/gitFixer.js';

test('transcript: one format for every agent — header, messages, events invisible to replay, torn line tolerated', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-llm-')), 'run.jsonl');
  const t = new Transcript({
    type: 'session', agent: 'gitFixer', provider: 'anthropic', model: 'm',
    created_at: 'now', system_prompt: 'SYS', branch: 'agent/s1',
  }, file);
  t.append({ role: 'user', content: 'go' });
  t.appendAll([{ role: 'assistant', content: 'done' }]);
  t.appendEvent({ type: 'interrupted', step: 1, spoken: 'do' });
  const back = loadTranscriptFile(file);
  assert.equal(back.header?.agent, 'gitFixer');
  assert.equal(back.header?.system_prompt, 'SYS');
  assert.equal(back.header?.branch, 'agent/s1', 'extra header fields survive');
  assert.deepEqual(back.messages.map((m) => m.role), ['user', 'assistant'], 'the event is not a message');
  // a torn last line (killed mid-append) costs that line, nothing else
  const raw = readFileSync(file, 'utf8');
  const torn = join(mkdtempSync(join(tmpdir(), 'phantom-llm-')), 'torn.jsonl');
  writeFileSync(torn, raw + '{"role":"assistant","content":"cut off');
  assert.deepEqual(loadTranscriptFile(torn).messages.map((m) => m.role), ['user', 'assistant']);
});

import { parseTranscript, serializeTranscript, memoryRecorder, sumUsageFromJsonl, usageEvent } from '../core/llm/transcript.js';

test('transcript: usage lines — appendStep writes them, a rebuild keeps them in place, sums come off the raw text', () => {
  // appendStep = the per-step write every file-backed agent inherits: the
  // step's messages plus one usage line, right behind them.
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-llm-')), 'usage.jsonl');
  const t = new Transcript({ type: 'session', provider: 'p', model: 'm', created_at: 'now' }, file);
  t.append({ role: 'user', content: 'go' });
  t.appendStep([{ role: 'assistant', content: 'step one' }],
    { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 5 } });
  t.appendStep([{ role: 'assistant', content: 'step two' }], undefined); // provider reported nothing → zeros
  const raw = readFileSync(file, 'utf8');
  assert.deepEqual(sumUsageFromJsonl(raw), { input: 100, output: 10, cache_read: 80, cache_write: 5 });

  // Parse keeps the lines as positioned events; replay never sees them.
  const back = parseTranscript(raw);
  assert.deepEqual(back.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.deepEqual(back.events.map((e) => e.at), [2, 3], 'each usage line sits behind its step');

  // A memory-backed caller (the looper, the turn route) rebuilds the record
  // from parsed messages — the events ride through serializeTranscript, so
  // nothing is lost and the sums still agree.
  const rebuilt = serializeTranscript(back.header!, back.messages, back.events);
  assert.equal(rebuilt, raw, 'rebuild is byte-identical — usage lines in place');

  // memoryRecorder positions a new turn's usage after the messages it followed.
  const { record, events } = memoryRecorder(back.messages.length);
  record.appendStep([{ role: 'assistant', content: 'step three' }], { inputTokens: 7, outputTokens: 3 });
  assert.deepEqual(events, [{ at: 4, event: usageEvent({ inputTokens: 7, outputTokens: 3 }) }]);
  const grown = serializeTranscript(back.header!, [...back.messages, { role: 'assistant', content: 'step three' }],
    [...back.events, ...events]);
  assert.deepEqual(sumUsageFromJsonl(grown), { input: 107, output: 13, cache_read: 80, cache_write: 5 });
});

test('transcript: an assistant tool call with no result is cut, so a resumed chat is never rejected', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-llm-')), 'dangling.jsonl');
  const t = new Transcript({ type: 'session', provider: 'p', model: 'm', created_at: 'now' }, file);
  t.append({ role: 'user', content: 'hi' });
  t.append({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: {} }] });
  // killed before the tool result landed
  assert.deepEqual(loadTranscriptFile(file).messages.map((m) => m.role), ['user']);
});

test('runGitFixer hands every attempt its own transcript path, in the session logs dir (outside repo/)', async () => {
  const paths: (string | undefined)[] = [];
  const driver: GitFixerDriver = {
    available: async () => true,
    async runSession(_exec, _branch, _sid, transcriptPath) { paths.push(transcriptPath); },
  };
  const dir = join(mkdtempSync(join(tmpdir(), 'phantom-llm-')), 'repo');
  await runGitFixer(dir, async () => ({ stdout: '', stderr: '', exitCode: 1 }), 'agent/s1', driver,
    { attempts: 2 }, 's1');
  assert.equal(paths.length, 2, 'one per attempt');
  assert.notEqual(paths[0], paths[1], 'each attempt is its own conversation');
  for (const p of paths) {
    assert.match(String(p), /\/logs\/git-fixer-.*a\d\.jsonl$/);
    assert.ok(!String(p).includes('/repo/'), 'never inside repo/ — auto-push must not commit it');
  }
});

// ── the per-agent cascade (core/llm/agentConfig.ts) ─────────────────────────
// A non-coding agent's provider/model/base_url fall back to the coding
// agent's only while the resolved provider IS the coding provider; a
// cross-provider override makes the model required and stops base_url
// inheriting. Enforced at build time — the store cannot see the pair.
import { cascade, agentModelConfig } from '../core/llm/agentConfig.js';

const CODING = { provider: 'anthropic', model: 'claude-opus-5', base_url: null,
  reasoning: 'medium', anthropic_api_key: 'sk-ant', google_api_key: 'sk-goog' };

test('cascade: nothing set inherits the whole coding config', () => {
  const c = cascade(CODING, 'supervisor');
  assert.deepEqual(c, { provider: 'anthropic', model: 'claude-opus-5', baseUrl: null });
});

test('cascade: a same-provider override still inherits the rest — compatibility, not override-ness', () => {
  const c = cascade({ ...CODING, supervisor_provider: 'anthropic' }, 'supervisor');
  assert.equal(c.model, 'claude-opus-5', 'the coding model carries over: the provider matches');
});

test('cascade: model alone swaps within the coding provider', () => {
  const c = cascade({ ...CODING, supervisor_model: 'claude-sonnet-5' }, 'supervisor');
  assert.deepEqual(c, { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: null });
});

test('cascade: a different provider requires its own model — a claude id on a google config is garbage', () => {
  assert.throws(() => cascade({ ...CODING, supervisor_provider: 'google' }, 'supervisor'),
    /supervisor_provider is google but supervisor_model is not set/);
  const c = cascade({ ...CODING, supervisor_provider: 'google',
    supervisor_model: 'gemini-3-pro' }, 'supervisor');
  assert.deepEqual(c, { provider: 'google', model: 'gemini-3-pro', baseUrl: null });
});

test('cascade: base_url never crosses providers — an endpoint only means something for its own', () => {
  const cfg = { ...CODING, provider: 'openai-compatible', base_url: 'http://ollama:11434',
    supervisor_provider: 'anthropic', supervisor_model: 'claude-opus-5' };
  assert.equal(cascade(cfg, 'supervisor').baseUrl, null, 'the coding endpoint stays behind');
  assert.equal(cascade({ ...cfg, supervisor_base_url: 'https://own' }, 'supervisor').baseUrl,
    'https://own', 'its own endpoint rides');
  assert.equal(cascade({ ...CODING, base_url: 'https://shared' }, 'supervisor').baseUrl,
    'https://shared', 'and inherits while the provider matches');
});

test("cascade: '' and null both mean unset — the existing overrides' convention", () => {
  const c = cascade({ ...CODING, supervisor_provider: '', supervisor_model: '' }, 'supervisor');
  assert.deepEqual(c, { provider: 'anthropic', model: 'claude-opus-5', baseUrl: null });
});

test('agentModelConfig: the key follows whichever provider WON, from the same settings read', () => {
  assert.equal(agentModelConfig(CODING, 'supervisor').apiKey, 'sk-ant');
  assert.equal(agentModelConfig({ ...CODING, supervisor_provider: 'google',
    supervisor_model: 'gemini-3-pro' }, 'supervisor').apiKey, 'sk-goog');
});

// ── no default provider ─────────────────────────────────────────────────────
// Nothing is chosen until a person chooses it (phantom-backend/settings.ts).
// A build still succeeds — a session opens on a bare server — and the FIRST
// CALL fails with the fix in the message; the cascade for the other agents
// throws at build, which is a blocked card or a notice with the same words.
import { cascade as cascade2, modelConfigFrom as modelConfigFrom2, buildCodingAgent as buildCodingAgent2 } from '../core/llm/agentConfig.js';
import { languageModel as languageModel2, NO_PROVIDER } from '../core/llm/createAgent.js';

test('no provider: the coding agent builds, says "unset", and its first call names /model', async () => {
  const cfg = { provider: null, model: null, base_url: null, reasoning: 'medium', max_steps: null };
  const c = modelConfigFrom2(cfg);
  assert.equal(c.provider, '');
  assert.equal(c.model, '');
  const { summary } = buildCodingAgent2(cfg, {});
  assert.deepEqual([summary.provider, summary.model], ['unset', 'unset']);
  const m = languageModel2(c) as { doGenerate: () => Promise<unknown> };
  await assert.rejects(m.doGenerate(), (e: Error) => e.message === NO_PROVIDER && /\/model/.test(e.message));
});

test('provider set, model empty: the call names the provider and /model', async () => {
  const m = languageModel2(modelConfigFrom2({ provider: 'anthropic', model: '' })) as { doStream: () => Promise<unknown> };
  await assert.rejects(m.doStream(), /no model set for anthropic — pick one on \/model/);
});

test('cascade with no provider anywhere throws the same message; an agent-level provider stands on its own', () => {
  assert.throws(() => cascade2({ provider: null, model: null }, 'supervisor'), (e: Error) => e.message === NO_PROVIDER);
  assert.deepEqual(cascade2({ provider: null, model: null, supervisor_provider: 'openai', supervisor_model: 'gpt-x' }, 'supervisor'),
    { provider: 'openai', model: 'gpt-x', baseUrl: null });
  assert.throws(() => cascade2({ provider: 'anthropic', model: null }, 'supervisor'), /no model set for anthropic/);
});
