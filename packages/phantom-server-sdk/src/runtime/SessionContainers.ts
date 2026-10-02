// SessionContainers — one container per session that owns a workspace;
// a session that borrows the workspace (a supervisor, the assistant) runs
// inside the owner's container. Stateless: repo/, scratch/, logs/ live on
// the volume. Boots on the first tool call, dies after container_idle_ms
// of none, recreated transparently. Stub.
export class SessionContainers {
  /** The container name for a session: phantom-looper-session-<id>. */
  nameOf(sessionId: string): string { throw stub(); }
  /** The running container, created and started if absent. Serialized per session. */
  async ensure(sessionId: string): Promise<{ id: string }> { throw stub(); }
  async remove(sessionId: string): Promise<void> { throw stub(); }
  /** Session ids with a running container, read from Docker. */
  async listRunning(): Promise<string[]> { throw stub(); }
  /** Remove containers idle longer than idleMs (the maintenance loop). */
  async reapIdle(idleMs: number, idleSessionIds: (idleMs: number) => Promise<string[]>): Promise<void> { throw stub(); }
  onStarted(listener: (sessionId: string) => void): () => void { throw stub(); }
  onRemoved(listener: (sessionId: string) => void): () => void { throw stub(); }
}
const stub = () => new Error('stub');
