// The folder row's one owner. A folder is a checkout's identity — the branch
// and the commit it was cut from. The directory on disk is named by this
// id (which equals the owning session's id). The row is permanent: it is what
// remembers the branch; the FILES can be deleted and re-cloned from it.
import { eq, inArray } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { folders, type FolderRow } from './db/schema.js';

export class Folders {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<FolderRow | undefined> {
    const rows = await this.db.select().from(folders).where(eq(folders.id, id));
    return rows[0];
  }

  /** Each folder's branch, by id — the work-state refresh walks a batch. */
  async branchesOf(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db.select({ id: folders.id, branch: folders.branch })
      .from(folders).where(inArray(folders.id, ids));
    return new Map(rows.map((f) => [f.id, f.branch]));
  }

  /** Born with its session, sharing the id: the branch it was cut on and the
   *  commit it was cut from. */
  async create(folder: { id: string; workspaceId: string; branch: string; cutFromSha: string }): Promise<void> {
    await this.db.insert(folders).values({ ...folder, createdAt: new Date() });
  }
}
