// The Anthropic subscription-OAuth disguise: token detection + the system-block
// insertion the subscription gate requires. Pure units — no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAnthropicOAuth, withClaudeCodeIdentity, CLAUDE_CODE_SYSTEM } from './agent.js';

test('isAnthropicOAuth: OAuth tokens yes, Console keys and junk no', () => {
  assert.equal(isAnthropicOAuth('sk-ant-oat01-abc'), true);
  assert.equal(isAnthropicOAuth('sk-ant-sid01-abc'), true);
  assert.equal(isAnthropicOAuth('sk-ant-api03-abc'), false); // Console API key
  assert.equal(isAnthropicOAuth('sk-proj-openai'), false);
  assert.equal(isAnthropicOAuth(undefined), false);
  assert.equal(isAnthropicOAuth(''), false);
});

test('identity is spliced first ahead of a string system prompt', () => {
  const out = withClaudeCodeIdentity('You are a coding agent.');
  assert.deepEqual(out, [
    { type: 'text', text: CLAUDE_CODE_SYSTEM },
    { type: 'text', text: 'You are a coding agent.' },
  ]);
});

test('identity is prepended to an existing block array', () => {
  const out = withClaudeCodeIdentity([{ type: 'text', text: 'real' }]);
  assert.equal(out[0].text, CLAUDE_CODE_SYSTEM);
  assert.equal(out[1].text, 'real');
});

test('absent or empty system becomes the identity alone', () => {
  assert.deepEqual(withClaudeCodeIdentity(undefined), [{ type: 'text', text: CLAUDE_CODE_SYSTEM }]);
  assert.deepEqual(withClaudeCodeIdentity(''), [{ type: 'text', text: CLAUDE_CODE_SYSTEM }]);
});

test('idempotent: identity already first is left untouched', () => {
  const once = withClaudeCodeIdentity('real');
  const twice = withClaudeCodeIdentity(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.filter((b) => b.text === CLAUDE_CODE_SYSTEM).length, 1);
});
