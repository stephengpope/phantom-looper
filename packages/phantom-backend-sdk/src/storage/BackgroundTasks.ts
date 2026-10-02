// BackgroundTasks — one row per detached command a session's agent runs:
// its argv, its log file, its container session id (sid), and how it
// ended. The task_* tools and the /tasks screen read it. Stub.
export interface BackgroundTaskRow {
  id: string; sessionId: string; argv: string[]; logPath: string; sid: string | null;
  status: 'running' | 'exited' | 'killed' | 'lost'; exitCode: number | null; startedAt: Date; endedAt: Date | null;
}

export class BackgroundTasks {
  async get(id: string): Promise<BackgroundTaskRow | undefined> { throw stub(); }
  async getInSession(id: string, sessionId: string): Promise<BackgroundTaskRow | undefined> { throw stub(); }
  async listForSession(sessionId: string, limit: number): Promise<BackgroundTaskRow[]> { throw stub(); }
  async start(task: Pick<BackgroundTaskRow, 'id' | 'sessionId' | 'argv' | 'logPath'>): Promise<BackgroundTaskRow> { throw stub(); }
  async setSid(id: string, sid: string): Promise<void> { throw stub(); }
  async finish(id: string, status: 'exited' | 'lost', exitCode: number | null): Promise<void> { throw stub(); }
  async markKilled(id: string): Promise<void> { throw stub(); }
  /** Of these session ids, the ones with a task still running. */
  async sessionsWithRunning(sessionIds: string[]): Promise<Set<string>> { throw stub(); }
}
const stub = () => new Error('stub');
