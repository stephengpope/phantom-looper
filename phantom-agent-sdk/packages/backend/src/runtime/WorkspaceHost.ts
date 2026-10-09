// WorkspaceHost — the ONE interface through which the backend touches a
// workspace: its files, its git, its container, its watcher. The backend
// never opens a workspace path or a Docker daemon itself; it asks the host
// the workspace is placed on. Two implementations:
//
//   LocalHost   the primitives, run here: this process's volume and Docker.
//               The backend's own runner on every server, and the body of a
//               session runner process (host/SessionRunner.ts), which runs the
//               same code against ITS volume and Docker.
//   RemoteHost  the same primitives as jobs over a session runner's link —
//               a proxy; nothing runs in this process.
//
// What stays in the backend: every decision. Which image and limits a
// container gets (settings), what a sync does and when, who owns what. The
// host is dumb on purpose: it trusts the backend with anything it asks, and
// a job carries everything the host needs to run it.
//
// Paths: a host primitive takes a workspace id and a path RELATIVE to the
// workspace's directory (work/<id>): `repo/...`, `scratch/...`, `logs/...`,
// `web/...`. The host confines every path to that directory; `..` is refused.
import type { GitAuth } from '../git/Git.js';
import type { Sandbox } from './Sandbox.js';

/** One checkout's git: every command runs in `repo/` of the workspace.
 *  `auth` carries the remote URL and the token — the host never reads the
 *  repo's own remote config (git/Git.ts guards). */
export interface Repo {
  git(args: string[], auth?: GitAuth): Promise<{ stdout: string; stderr: string }>;
  /** Does `rel` (under repo/) exist? */
  exists(rel: string): Promise<boolean>;
}

export type FileType = 'file' | 'dir' | 'link' | 'other';
export interface FileStat { size: number; mtimeMs: number; type: FileType }

/** One workspace's directory, by relative path. `read`, `stat` and `list`
 *  answer null for a path that is not there; `write` makes the parents. */
export interface WorkspaceFiles {
  read(rel: string): Promise<Buffer | null>;
  write(rel: string, data: Buffer): Promise<void>;
  /** The last `bytes` of a file (a log's tail); empty when absent. */
  tail(rel: string, bytes: number): Promise<Buffer>;
  stat(rel: string): Promise<FileStat | null>;
  list(rel: string): Promise<Array<{ name: string; type: FileType }> | null>;
  mkdir(rel: string): Promise<void>;
  rm(rel: string): Promise<void>;
  /** The real path of `rel` when it resolves to a regular file INSIDE the
   *  workspace (symlinks followed), as the host sees it; null otherwise. For
   *  the guards that refuse a link pointing out. */
  realFile(rel: string): Promise<string | null>;
}

/** Everything a container creation needs, decided by the backend
 *  (SessionContainers.plan) and carried whole to the host. */
export interface ContainerPlan {
  image: string;
  env: string[];
  memMb: number | null;
  cpus: number | null;
  pids: number | null;
  docker: boolean;
  sudo: boolean;
  runtime: string | null;
  /** The checkout and the container's own disk held to this many GB. */
  diskGb: number | null;
  /** The project's database host name: the container joins a private
   *  network with the database server (local hosts only). */
  databaseHost: string | null;
}

export type ContainerState = 'running' | 'stopped' | 'absent';

/** What a detached command reports as it runs: its process-session id once
 *  captured, then its end. */
export type DetachEvent =
  | { event: 'sid'; sid: string }
  | { event: 'exit'; status: 'exited' | 'killed' | 'orphaned'; exitCode: number | null };

export interface WorkspaceHost {
  /** The host's row id; null is the backend's own runner (this process). */
  readonly id: string | null;
  readonly name: string;
  /** Online right now. The backend's own always is; a remote host is while
   *  its link is up. A job for an offline host WAITS — it never fails. */
  readonly online: boolean;

  // ── the checkout ──────────────────────────────────────────────────────
  /** The files for a workspace: a warm slot claimed from the pool when the
   *  host has one, else a fresh clone of `branch` — then `scratch/` and
   *  `logs/` made. */
  checkout(workspaceId: string, projectId: string, branch: string, auth: GitAuth): Promise<'claimed' | 'cloned'>;
  /** The whole workspace directory, gone. */
  removeFiles(workspaceId: string): Promise<void>;
  repo(workspaceId: string): Repo;
  files(workspaceId: string): WorkspaceFiles;

  // ── the container ─────────────────────────────────────────────────────
  /** The workspace's container running as planned: left as is when up,
   *  recreated when stopped, created when absent (the image pulled when
   *  missing). `created` says whether a container came up in this call. */
  containerUp(workspaceId: string, plan: ContainerPlan): Promise<{ created: boolean }>;
  containerRemove(workspaceId: string): Promise<void>;
  /** Probed, never created. */
  containerState(workspaceId: string): Promise<ContainerState>;
  /** The workspaces with a running container on this host. */
  activeWorkspaces(): Promise<string[]>;
  /** Exec on the running container. The container must be up (containerUp). */
  sandbox(workspaceId: string): Sandbox;
  /** A command that outlives the call: its output goes to
   *  `logs/<taskId>.ndjson` on the host's volume as it runs; the stream
   *  reports the sid once read off `sidfile`, then the end. */
  detach(workspaceId: string, taskId: string, argv: string[], cwd: string | undefined, sidfile: string): AsyncIterable<DetachEvent>;

  // ── the watcher ───────────────────────────────────────────────────────
  /** `onChange` fires on any change under repo/ (and once on every
   *  watcher restart). A second call for the id replaces the callback. */
  watch(workspaceId: string, onChange: () => void): void;
  unwatch(workspaceId: string): void;

  // ── the box ───────────────────────────────────────────────────────────
  /** The volume's disk: used percent and free GB. */
  disk(): Promise<{ usedPct: number; freeGB: number }>;
  /** Null when this host can hold a container to `container_disk_gb`,
   *  else why not. */
  diskSupport(): Promise<string | null>;
}
