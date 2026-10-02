// Projects — the projects table's one owner: a registered repo (owner,
// name), its base branch and branch prefix, its board columns and the
// next card number. Stub.
export interface ProjectRow {
  id: string; owner: string; name: string; displayName: string | null;
  baseBranch: string; branchPrefix: string; kanbanColumns: string[] | null; nextCardNumber: number; createdAt: Date;
}
export interface NewProject { owner: string; name: string; baseBranch: string; branchPrefix?: string; displayName?: string | null }

export class Projects {
  async get(id: string): Promise<ProjectRow | undefined> { throw stub(); }
  async list(): Promise<ProjectRow[]> { throw stub(); }
  /** Register a repo. Rejects a second row for the same owner/name. */
  async create(project: NewProject, by?: string): Promise<ProjectRow> { throw stub(); }
  async update(id: string, patch: Partial<Pick<ProjectRow, 'displayName' | 'baseBranch' | 'branchPrefix'>>, by?: string): Promise<ProjectRow> { throw stub(); }
  /** Delete the project and, by cascade, its workspaces, sessions, cards, crons, settings scope. */
  async remove(id: string, by?: string): Promise<void> { throw stub(); }
  /** The board's column list: the row's, or the default. */
  columnsOf(project: ProjectRow): string[] { throw stub(); }
  /** The card prefix (`PHA` in PHA-7): the `card_prefix` setting, or one derived from the repo name. */
  async cardPrefixOf(project: ProjectRow): Promise<string> { throw stub(); }
  /** Take the next card number, inside the caller's transaction. Never reused. */
  async claimCardNumber(id: string, tx?: unknown): Promise<number> { throw stub(); }
}
const stub = () => new Error('stub');
