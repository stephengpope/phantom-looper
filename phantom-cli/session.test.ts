// adoptServerCopy: the server's transcript seats the local file — except a
// local file that is the server's text plus unsaved steps, which is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptServerCopy } from './session.js';

const SERVER = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}\n';
const EXTRA = '{"role":"user","content":"more"}\n{"role":"assistant","content":[{"type":"tool-call","toolCallId":"t1","toolName":"bash","input":{}}]}\n';
const file = () => join(mkdtempSync(join(tmpdir(), 'phantom-seat-')), 's.jsonl');

test('no local file: the server copy is written, empty included', () => {
  const f = file();
  assert.deepEqual(adoptServerCopy('s', SERVER, f), { text: SERVER, localKept: false });
  assert.equal(readFileSync(f, 'utf8'), SERVER);
  const g = file();
  assert.deepEqual(adoptServerCopy('s', null, g), { text: '', localKept: false });
  assert.ok(existsSync(g) && readFileSync(g, 'utf8') === '', 'an empty file: the working copy appends extend');
});

test('local = server text plus more: the local file is kept and reported', () => {
  const f = file();
  writeFileSync(f, SERVER + EXTRA);
  assert.deepEqual(adoptServerCopy('s', SERVER, f), { text: SERVER + EXTRA, localKept: true });
  assert.equal(readFileSync(f, 'utf8'), SERVER + EXTRA, 'untouched');
});

test('server has nothing, local has a conversation: local is kept (the crash-then-reopen case)', () => {
  const f = file();
  writeFileSync(f, EXTRA);
  assert.deepEqual(adoptServerCopy('s', null, f), { text: EXTRA, localKept: true });
});

test('same text, or local shorter, or diverged after a common start: the server wins', () => {
  const same = file(); writeFileSync(same, SERVER);
  assert.deepEqual(adoptServerCopy('s', SERVER, same), { text: SERVER, localKept: false });

  const shorter = file(); writeFileSync(shorter, SERVER.split('\n')[0] + '\n');
  assert.deepEqual(adoptServerCopy('s', SERVER, shorter), { text: SERVER, localKept: false });
  assert.equal(readFileSync(shorter, 'utf8'), SERVER);

  // Both sides ran turns after the same moment: the saved ones are the record.
  const diverged = file(); writeFileSync(diverged, SERVER + EXTRA);
  const elsewhere = SERVER + '{"role":"user","content":"from telegram"}\n';
  assert.deepEqual(adoptServerCopy('s', elsewhere, diverged), { text: elsewhere, localKept: false });
  assert.equal(readFileSync(diverged, 'utf8'), elsewhere, 'the local extra is discarded');
});
