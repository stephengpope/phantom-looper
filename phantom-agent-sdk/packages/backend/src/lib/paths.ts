// Path math only — no db, no docker, nothing that has to be running for these
// to be true. All three trees MUST live on one filesystem (the named volume):
// rename is atomic within a filesystem and fails across them, and that
// atomicity is the entire concurrency story.
import path from 'node:path';

export interface Paths {
  root: string;
  poolSetup: string;
  poolReady: string;
  work: string;
}

export function makePaths(root: string): Paths {
  return {
    root,
    poolSetup: path.join(root, 'pool', 'setup'),
    poolReady: path.join(root, 'pool', 'ready'),
    work: path.join(root, 'work'),
  };
}

export function sessionDir(paths: Paths, sessionId: string): string {
  return path.join(paths.work, sessionId);
}
export function repoDir(paths: Paths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), 'repo');
}

/** Slot names carry their own metadata: which PROJECT they serve (never just
 *  the repo — two organizations' projects on one repo each clone with their
 *  own token and never share a checkout), and — via the
 *  ULID — when they were stocked, so eviction needs no marker file. */
export function slotPrefix(projectId: string, branch: string): string {
  return `${projectId}__${branch}__`;
}
export function slotUlid(slotName: string): string {
  const i = slotName.lastIndexOf('__');
  return slotName.slice(i + 2);
}
