import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
class Stdin extends EventEmitter { isTTY = true; setRawMode() {} setEncoding() {} resume() {} pause() {} ref() {} unref() {} buf: string[] = []; read() { return this.buf.shift() ?? null; } write(s: string) { this.buf.push(s); this.emit('readable'); return true; } }
class Stdout extends EventEmitter { columns = 100; rows = 40; frames: string[] = []; write(s: string) { this.frames.push(s); return true; } get last() { return this.frames[this.frames.length - 1] ?? ''; } }
const stdinDev = new Stdin(); const stdoutDev = new Stdout();
import { Secrets } from '../../phantom-cli/components/Secrets.js';

const calls: string[] = [];
const store = new Map<string, { description: string; value: string }>();
const api = async (method: string, path: string, body?: any) => {
  calls.push(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
  const [p, q] = path.split('?');
  const ws = q ? new URLSearchParams(q).get('workspace') : null;
  const name = decodeURIComponent(p.replace('/secrets/', ''));
  if (method === 'GET' && p === '/workspaces') return [{ id: 'w1', name: 'alpha' }];
  if (method === 'GET' && p === '/secrets') return { secrets: [...store].map(([k, v]) => {
    const [w, n] = k.split('|'); return { name: n, description: v.description, scope: w ? 'workspace' : 'global', ...(w ? { workspace: w } : {}) }; }) };
  if (method === 'PUT') {
    const k = `${ws ?? ''}|${name}`; const cur = store.get(k);
    if (!body.value && !cur) throw new Error('value required');
    store.set(k, { description: body.description, value: body.value ?? cur!.value }); return {};
  }
  if (method === 'GET') { const v = store.get(`${ws ?? ''}|${name}`) ?? store.get(`|${name}`); if (!v) throw new Error('404'); return { value: v.value }; }
  if (method === 'DELETE') { store.delete(`${ws ?? ''}|${name}`); return {}; }
  throw new Error('unhandled ' + method + path);
};

const { unmount } = render(<Secrets api={api as any} onClose={() => {}} />, { stdin: stdinDev as any, stdout: stdoutDev as any, debug: true, patchConsole: false });
const stdin = stdinDev; const lastFrame = () => stdoutDev.last;
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const type = async (s: string) => { for (const c of s) { stdin.write(c); await tick(5); } await tick(); };
const key = async (k: string) => { stdin.write(k); await tick(80); };
const ENTER = '\r', TAB = '\t', ESC = '\x1b', RIGHT = '\x1b[C';

(async () => {
  await tick(200);
  // NEW: n, name, enter, description, enter, value, enter
  await key('n'); await type('my_key'); await key(ENTER);
  console.log('after name:', calls.filter(c => c.startsWith('PUT')).length, 'PUTs (expect 0)');
  await type('the desc'); await key(ENTER);
  console.log('after desc:', calls.filter(c => c.startsWith('PUT')).length, 'PUTs (expect 0)');
  await type('s3cret'); await key(ENTER);
  console.log('after value:', calls.filter(c => c.startsWith('PUT')).length, 'PUTs (expect 1)');
  console.log(lastFrame());
  // now on Where: cycle to workspace and leave → move
  await key(RIGHT); await key(TAB);
  await tick(100);
  console.log('after where:', calls.slice(-4));
  console.log('store:', [...store]);
  // esc closes; list shows the row
  await key(ESC); await tick(150);
  console.log(lastFrame());
  // EDIT: enter on row, change description only, esc
  await key(ENTER); await tick(100); await key(TAB); await type(' more'); await key(ESC); await tick(150);
  console.log('edit desc:', calls.slice(-3));
  console.log('store:', [...store]);
  unmount();
})();
