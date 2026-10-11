// The sessions whose files are on a disk, each with its project row — what
// the backup and the disk jobs walk. Only owners hold disk (a supervisor or
// an assistant borrows its coder's checkout).
import type { SessionRow, ProjectRow } from '../storage/schema.js';
import type { Projects } from '../storage/Projects.js';
import type { Sessions } from '../storage/Sessions.js';

export interface Owner { session: SessionRow; project: ProjectRow }

/** Fails CLOSED like every job that deletes: an unreadable list aborts the
 *  run — not knowing what is protected never licenses deletion. */
export async function workspaceOwners(projects: Projects, sessions: Sessions): Promise<Owner[]> {
  const rows = await sessions.listOwnersOnDisk();
  const byId = new Map((await projects.list()).map((project) => [project.id, project]));
  return rows.flatMap((session) => {
    const project = byId.get(session.projectId);
    return project ? [{ session, project }] : [];
  });
}
