// The project row's one owner: a registered repository, its base branch,
// its branch prefix, and the board facts the row carries — the column list,
// the card prefix and the next card number.
//
// Every project-row change announces itself on the settings feed: to every
// client a project changing IS a settings-shaped fact (the list, the
// prefixes, the scopes), and the settings feed is what they already follow to
// re-read /projects. One bus, not a second one saying the same thing.
import { eq, sql } from 'drizzle-orm';
import { Database, type Drizzle, type Transaction } from 'phantom-backend-sdk';
import { projects, type ProjectRow } from 'phantom-backend-sdk/schema';
import { DEFAULT_COLUMNS } from 'phantom-backend-sdk';
import type { Settings } from './settings.js';
import { projectScope } from 'phantom-backend-sdk';
import type { SettingsEvents } from './api/settingsEvents.js';
import type { AgentDatabases } from 'phantom-backend-sdk';

export { DEFAULT_COLUMNS };

/** First 3 letters of the repo name, uppercased — "phantom-looper" → "PHA". */
export function defaultPrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, '');
  return (letters || 'TSK').slice(0, 3).toUpperCase();
}

/** The board's columns: the project's own list, or the default. */
export const columnsOf = (project: ProjectRow): string[] =>
  (Array.isArray(project.kanbanColumns) && project.kanbanColumns.length ? project.kanbanColumns : DEFAULT_COLUMNS);

/** What a new project is registered with — the route resolved the URL and
 *  (for create=true) made the repository first. */
export interface NewProject {
  id: string; owner: string; name: string;
  displayName: string | null; baseBranch: string; branchPrefix: string;
}

/** A write the table refuses, with the API's error code already chosen. */
export class ProjectError extends Error {
  constructor(readonly code: 'already_registered', message: string) { super(message); }
}

export class Projects {
  constructor(
    private readonly db: Drizzle,
    private readonly settings: Settings,
    private readonly events?: SettingsEvents,
    /** The agent's own database per project — dropped with the row. */
    private readonly databases?: AgentDatabases,
  ) {}

  async get(id: string): Promise<ProjectRow | undefined> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, id));
    return rows[0];
  }

  /** THE project order — by the name a person sees (display name, else
   *  repo name), case-insensitive. /project, /resume's project cycle and
   *  the Assistant all read this list, so the order lives here and nowhere
   *  else; without it the rows came back in table order, which is stable
   *  only by luck. */
  async list(): Promise<ProjectRow[]> {
    return this.db.select().from(projects)
      .orderBy(sql`lower(coalesce(${projects.displayName}, ${projects.name}))`, projects.id);
  }

  /** The card number prefix ("PHA"): the `card_prefix` setting at this
   *  project's layer, else the repo name's first three letters. */
  async prefixOf(project: ProjectRow): Promise<string> {
    return (await this.settings.resolve('card_prefix', { project })) ?? defaultPrefix(project.name);
  }

  /** Refuses a repo that is already a project (`owner, name` is unique). */
  async create(row: NewProject, by?: string): Promise<ProjectRow> {
    try {
      await this.db.insert(projects).values(row);
    } catch (e) {
      if (Database.isUniqueViolation(e)) throw new ProjectError('already_registered', `${row.owner}/${row.name} is already a project`);
      throw e;
    }
    this.events?.publish(projectScope(row.id), [], by);
    return (await this.get(row.id))!;
  }

  /** The project's OWN fields — display name, base branch, branch prefix.
   *  Everything else about a project is a setting at its layer. */
  async update(id: string, patch: Partial<Pick<ProjectRow, 'displayName' | 'baseBranch' | 'branchPrefix'>>,
    by?: string): Promise<void> {
    if (!Object.keys(patch).length) return;
    await this.db.update(projects).set(patch).where(eq(projects.id, id));
    this.events?.publish(projectScope(id), [], by);
  }

  /** Hand out the next card number and move the counter, in the caller's
   *  transaction so the number and the card land together. Numbers are
   *  never reused: a deleted card's stays taken. */
  async claimCardNumber(id: string, tx: Transaction | Drizzle = this.db): Promise<number> {
    const [{ number }] = await tx.update(projects)
      .set({ nextCardNumber: sql`${projects.nextCardNumber} + 1` })
      .where(eq(projects.id, id)).returning({ number: sql<number>`${projects.nextCardNumber} - 1` });
    return number;
  }

  /** The row goes; the agent's database and its settings layer (overrides,
   *  its own token) went first — a scope whose project is gone is a row
   *  nothing will ever read. Its cards, history, sessions and workspaces
   *  cascade; the route gates that behind its own confirm. */
  async remove(id: string, by?: string): Promise<void> {
    await this.databases?.drop(id);
    await this.settings.dropScope(projectScope(id));
    await this.db.delete(projects).where(eq(projects.id, id));
    this.events?.publish(projectScope(id), [], by);
  }
}
