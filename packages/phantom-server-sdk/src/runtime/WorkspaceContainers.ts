// WorkspaceContainers — one container per workspace, shared by every
// session on it. Stateless: repo/, scratch/, logs/ live on the volume.
// Boots on the first tool call, dies after container_idle_ms of none,
// recreated transparently. Stub.
export class WorkspaceContainers {
  /** The container name for a workspace: phantom-looper-ws-<id>. */
  nameOf(workspaceId: string): string { throw stub(); }
  /** The running container, created and started if absent. Serialized per workspace. */
  async ensure(workspaceId: string): Promise<{ id: string }> { throw stub(); }
  async remove(workspaceId: string): Promise<void> { throw stub(); }
  /** Workspace ids with a running container, read from Docker. */
  async listRunning(): Promise<string[]> { throw stub(); }
  /** Remove containers idle longer than idleMs (the maintenance loop). */
  async reapIdle(idleMs: number, idleWorkspaceIds: (idleMs: number) => Promise<string[]>): Promise<void> { throw stub(); }
  /** Hear a container come up / go away (instant sync subscribes). */
  onStarted(listener: (workspaceId: string) => void): () => void { throw stub(); }
  onRemoved(listener: (workspaceId: string) => void): () => void { throw stub(); }
}
const stub = () => new Error('stub');
