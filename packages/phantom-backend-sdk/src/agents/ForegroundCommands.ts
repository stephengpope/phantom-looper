// ForegroundCommands — a session's in-flight unary bash runs (pidfile per
// run) so an interrupt can kill the whole process group. Stub.
export class ForegroundCommands {
  add(sessionId: string, pidfile: string, workspaceId: string): void { throw stub(); }
  remove(sessionId: string, pidfile: string): void { throw stub(); }
  killAll(sessionId: string): void { throw stub(); }
}
const stub = () => new Error('stub');
