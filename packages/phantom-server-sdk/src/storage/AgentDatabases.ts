// AgentDatabases — the agent's own Postgres database, one per project:
// `project_<id>` on the same server, reached only as the login role of the
// same name (the fence). Created on first use. Stub.
export interface QueryOptions { limit?: number; maxCellChars?: number }
export interface StatementResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; command: string }

export class AgentDatabases {
  /** The database and role name for a project. */
  nameOf(projectId: string): string { throw stub(); }
  /** The role's connection string — what the workspace container gets as AGENT_DATABASE_URL when shared. */
  async urlFor(projectId: string): Promise<string> { throw stub(); }
  /** The role and database exist with a current password. Idempotent; concurrent calls share one run. */
  async ensure(projectId: string): Promise<void> { throw stub(); }
  /** Run the agent's SQL connected AS the project's role. */
  async query(projectId: string, sql: string, options: QueryOptions): Promise<StatementResult[]> { throw stub(); }
  /** The project is gone: drop its database and role. */
  async drop(projectId: string): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
