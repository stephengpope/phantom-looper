// The job protocol between the backend and a session host — the ONLY
// vocabulary the two speak. Jobs go DOWN the host's feed
// (GET /session-hosts/:id/jobs, ND-JSON); their events come UP the relay
// (POST /session-hosts/:id/jobs/events). Every job names a primitive of
// runtime/WorkspaceHost.ts and carries everything the host needs to run it.
//
// A job ends with exactly one `result` or `error`; a streaming job (exec
// streams, detached commands, a watch) sends `chunk`s first and `end` last.
// Bytes ride as base64. Ids are the backend's; a host that sees an id twice
// (a reconnect re-sends what is unfinished) runs it once.
import type { ContainerPlan } from '../runtime/WorkspaceHost.js';
import type { GitAuth } from '../git/Git.js';
import type { RunOpts } from '../runtime/Sandbox.js';

export type Job = { id: string } & (
  | { type: 'checkout'; workspaceId: string; projectId: string; branch: string; auth: GitAuth }
  | { type: 'removeFiles'; workspaceId: string }
  | { type: 'git'; workspaceId: string; args: string[]; auth?: GitAuth }
  | { type: 'exists'; workspaceId: string; rel: string }
  | { type: 'read'; workspaceId: string; rel: string }
  | { type: 'write'; workspaceId: string; rel: string; data: string }
  | { type: 'tail'; workspaceId: string; rel: string; bytes: number }
  | { type: 'stat'; workspaceId: string; rel: string }
  | { type: 'list'; workspaceId: string; rel: string }
  | { type: 'mkdir'; workspaceId: string; rel: string }
  | { type: 'rm'; workspaceId: string; rel: string }
  | { type: 'realFile'; workspaceId: string; rel: string }
  | { type: 'containerUp'; workspaceId: string; plan: ContainerPlan }
  | { type: 'containerRemove'; workspaceId: string }
  | { type: 'containerState'; workspaceId: string }
  | { type: 'activeWorkspaces' }
  | { type: 'exec'; workspaceId: string; argv: string[]; cwd?: string; stdin?: string; maxBytes?: number; timeoutMs?: number }
  | { type: 'execStream'; workspaceId: string; argv: string[]; cwd?: string; timeoutMs?: number }
  | { type: 'detach'; workspaceId: string; taskId: string; argv: string[]; cwd?: string; sidfile: string }
  | { type: 'watch'; workspaceId: string }
  | { type: 'unwatch'; workspaceId: string }
  | { type: 'cancel'; job: string }
  | { type: 'disk' }
  | { type: 'diskSupport' }
);

export type JobType = Job['type'];
/** A job without its id — per type, not the union's common fields. */
export type JobBody = Job extends infer J ? J extends { id: string } ? Omit<J, 'id'> : never : never;

/** What a host sends up about a job. `error` carries git's own fields
 *  (stderr, code) and a timed-out exec's output, so the backend's handlers
 *  read a remote failure exactly as a local one. */
export type JobEvent =
  /** The host's own heartbeat up the relay: alive, whatever the feed's socket
   *  says — and how loaded the box is, for placement. */
  | { type: 'heartbeat'; load?: HostLoad }
  | { job: string; type: 'result'; value: unknown }
  | { job: string; type: 'chunk'; value: unknown }
  | { job: string; type: 'end' }
  | { job: string; type: 'error'; message: string; detail?: Record<string, unknown> };

/** The hello a host sends before opening its feed: who it is (its persisted
 *  id, when it has one), its label, and what the box can do. `boot` is
 *  fresh per process: the backend tells a reconnect from a restart by it. */
export interface HostHello {
  id?: string;
  name: string;
  boot: string;
  facts: HostFacts;
}

/** What a host is carrying, on every heartbeat. `cpu` places (docs/
 *  host-load-placement.md): the one-minute load average over the CPU count,
 *  1.0 = every core busy. The rest is the status line's. */
export interface HostLoad {
  cpu: number;
  freeGB: number;
  usedPct: number;
  running: number;
}

export interface HostFacts {
  dockerVersion?: string;
  arch?: string;
  /** Null when the box can hold a container to `container_disk_gb`, else why not. */
  diskSupport: string | null;
  sdkVersion: string;
}

export const toBase64 = (data: Buffer): string => data.toString('base64');
export const fromBase64 = (text: string): Buffer => Buffer.from(text, 'base64');

/** A run's options over the wire: stdin as base64. */
export function encodeRunOpts(opts: RunOpts): { cwd?: string; stdin?: string; maxBytes?: number; timeoutMs?: number } {
  return {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.stdin !== undefined ? { stdin: toBase64(opts.stdin) } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

/** An error as the host reports it: the message, and the fields the
 *  backend's handlers read off a local one (git's stderr and exit code, a
 *  timed-out exec's output). */
export function encodeError(error: unknown): { message: string; detail?: Record<string, unknown> } {
  const failure = error as Error & { code?: unknown; stderr?: unknown; stdout?: unknown; statusCode?: unknown };
  const detail: Record<string, unknown> = {};
  if (failure?.code !== undefined) detail.code = failure.code;
  if (failure?.statusCode !== undefined) detail.statusCode = failure.statusCode;
  if (typeof failure?.stderr === 'string') detail.stderr = failure.stderr;
  else if (Buffer.isBuffer(failure?.stderr)) detail.stderrBytes = toBase64(failure.stderr);
  if (typeof failure?.stdout === 'string') detail.stdout = failure.stdout;
  else if (Buffer.isBuffer(failure?.stdout)) detail.stdoutBytes = toBase64(failure.stdout);
  return { message: failure?.message ?? String(error), ...(Object.keys(detail).length ? { detail } : {}) };
}

/** The error back as a local one: same message, same fields. */
export function decodeError(event: { message: string; detail?: Record<string, unknown> }): Error {
  const error = new Error(event.message) as Error & Record<string, unknown>;
  const detail = event.detail ?? {};
  if (detail.code !== undefined) error.code = detail.code;
  if (detail.statusCode !== undefined) error.statusCode = detail.statusCode;
  if (typeof detail.stderr === 'string') error.stderr = detail.stderr;
  if (typeof detail.stderrBytes === 'string') error.stderr = fromBase64(detail.stderrBytes);
  if (typeof detail.stdout === 'string') error.stdout = detail.stdout;
  if (typeof detail.stdoutBytes === 'string') error.stdout = fromBase64(detail.stdoutBytes);
  return error;
}
