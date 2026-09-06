import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestError } from './request.js';

const BASE = 'http://localhost:8080';

test('a network failure names the server and the cause, never "fetch failed" alone', () => {
  const e = requestError('GET', '/workspaces', BASE, Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  assert.equal(e.message, 'phantom-backend at http://localhost:8080 is not reachable (ECONNREFUSED)');
  assert.equal(e.code, 'unreachable');
});

test('a reply that is not JSON is "not reachable" too — something else answered at that address', () => {
  const e = requestError('GET', '/workspaces', BASE, new SyntaxError('Unexpected token <'));
  assert.equal(e.message, 'phantom-backend at http://localhost:8080 is not reachable (not a phantom-backend reply)');
});

test('a refused key says so and where the fix is, with the code for callers that branch', () => {
  const e = requestError('GET', '/workspaces', BASE, undefined, { status: 401, code: 'unauthorized', message: 'missing or invalid bearer token' });
  assert.equal(e.message, 'phantom-backend at http://localhost:8080 rejected the key — /server to fix it');
  assert.equal(e.code, 'unauthorized');
});

test("a server refusal is the server's own sentence, code attached", () => {
  const e = requestError('DELETE', '/sessions/s1', BASE, undefined, { status: 409, code: 'session_locked', message: 'session is in use on laptop — duplicate it to work beside the holder' });
  assert.equal(e.message, 'session is in use on laptop — duplicate it to work beside the holder');
  assert.equal(e.code, 'session_locked');
});

test('a refusal with no message still names the server, the call and the status', () => {
  const e = requestError('POST', '/sessions', BASE, undefined, { status: 502 });
  assert.equal(e.message, 'phantom-backend at http://localhost:8080 answered POST /sessions with HTTP 502 and no message');
});
