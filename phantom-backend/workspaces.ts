// The workspace row's one owner: a registered repository, its base branch,
// its branch prefix, and the board facts the row carries — the column list,
// the card prefix and the next card number.
//
// Every workspace-row change announces itself on the settings feed: to every
// client a workspace changing IS a settings-shaped fact (the list, the
// prefixes, the scopes), and the settings feed is what they already follow to
// re-read /workspaces. One bus, not a second one saying the same thing.
import { eq, sql } from 'drizzle-orm';
import { isUniqueViolation, type Db, type Tx } from './db/client.js';
import { workspaces, type WorkspaceRow } from './db/schema.js';
import { DEFAULT_COLUMNS } from '../core/kanban.js';
import type { Settings } from './settings.js';
import { workspaceScope } from './store.js';
import type { SettingsEvents } from './api/settingsEvents.js';
import type { Databases } from './databases.js';

export { DEFAULT_COLUMNS };

/** First 3 letters of the repo name, uppercased — "phantom-looper" → "PHA". */
export function defaultPrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, '');
  return (letters || 'TSK').slice(0, 3).toUpperCase();
}

/** The board's columns: the workspace's own list, or the default. */
export const columnsOf = (w: WorkspaceRow): string[] =>
  (Array.isArray(w.kanbanColumns) && w.kanbanColumns.length ? w.kanbanColumns : DEFAULT_COLUMNS);

/** What a new workspace is registered with — the route resolved the URL and
 *  (for create=true) made the repository first. */
export interface NewWorkspace {
  id: string; owner: string; name: string;
  displayName: string | null; baseBranch: string; branchPrefix: string;
}

/** A write the table refuses, with the API's error code already chosen. */
export class WorkspaceError extends Error {
  constructor(readonly code: 'already_registered', message: string) { super(message); }
}

export class Workspaces {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly events?: SettingsEvents,
    /** The agent's own database per workspace — dropped with the row. */
    private readonly databases?: Databases,
  ) {}

  async get(id: string): Promise<WorkspaceRow | undefined> {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, id));
    return rows[0];
  }

  async list(): Promise<WorkspaceRow[]> {
    return this.db.select().from(workspaces);
  }

  /** The card number prefix ("PHA"): the `card_prefix` setting at this
   *  workspace's layer, else the repo name's first three letters. */
  async prefixOf(w: WorkspaceRow): Promise<string> {
    return (await this.settings.resolve('card_prefix', { workspace: w })) ?? defaultPrefix(w.name);
  }

  /** Refuses a repo that is already a workspace (`owner, name` is unique). */
  async create(row: NewWorkspace, by?: string): Promise<WorkspaceRow> {
    try {
      await this.db.insert(workspaces).values(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new WorkspaceError('already_registered', `${row.owner}/${row.name} is already a workspace`);
      throw e;
    }
    this.events?.publish(workspaceScope(row.id), [], by);
    return (await this.get(row.id))!;
  }

  /** The workspace's OWN fields — display name, base branch, branch prefix.
   *  Everything else about a workspace is a setting at its layer. */
  async update(id: string, patch: Partial<Pick<WorkspaceRow, 'displayName' | 'baseBranch' | 'branchPrefix'>>,
    by?: string): Promise<void> {
    if (!Object.keys(patch).length) return;
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    this.events?.publish(workspaceScope(id), [], by);
  }

  /** Hand out the next card number and move the counter, in the caller's
   *  transaction so the number and the card land together. Numbers are
   *  never reused: a deleted card's stays taken. */
  async claimCardNumber(id: string, tx: Tx | Db = this.db): Promise<number> {
    const [{ number }] = await tx.update(workspaces)
      .set({ nextCardNumber: sql`${workspaces.nextCardNumber} + 1` })
      .where(eq(workspaces.id, id)).returning({ number: sql<number>`${workspaces.nextCardNumber} - 1` });
    return number;
  }

  /** The row goes; the agent's database and its settings layer (overrides,
   *  its own token) went first — a scope whose workspace is gone is a row
   *  nothing will ever read. Its cards, history, sessions and folders
   *  cascade; the route gates that behind its own confirm. */
  async remove(id: string, by?: string): Promise<void> {
    await this.databases?.drop(id);
    await this.settings.dropScope(workspaceScope(id));
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
    this.events?.publish(workspaceScope(id), [], by);
  }
}
