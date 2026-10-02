// SessionContainers — one container per session that OWNS a workspace,
// keyed by that owner's id. A session that borrows the workspace (a
// supervisor, the assistant) runs inside the owner's container: it passes
// its `workspaceId`, which IS the owner's session id. Stateless: repo/, scratch/, logs/ live on
// the volume. Boots on the first tool call, dies after container_idle_ms
// of none, recreated transparently. Stub.
export class SessionContainers {
  /** The container name for a session: phantom-looper-session-<id>. */
  nameOf(ownerSessionId: string): string { throw stub(); }
  /** The running container, created and started if absent. Serialized per session. */
  async ensure(ownerSessionId: string): Promise<{ id: string }> { throw stub(); }
  async remove(ownerSessionId: string): Promise<void> { throw stub(); }
  /** Session ids with a running container, read from Docker. */
  async listRunning(): Promise<string[]> { throw stub(); }
  /** Remove containers idle longer than idleMs (the maintenance loop). */
  async reapIdle(idleMs: number, idleOwnerSessionIds: (idleMs: number) => Promise<string[]>): Promise<void> { throw stub(); }
  onStarted(listener: (ownerSessionId: string) => void): () => void { throw stub(); }
  onRemoved(listener: (ownerSessionId: string) => void): () => void { throw stub(); }
}
const stub = () => new Error('stub');
