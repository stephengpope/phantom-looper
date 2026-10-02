// InstantSync — per-workspace file watching that fires the sync for you:
// auto-push after a debounce on change, auto-pull on an interval, for
// workspaces with a running container in a project with the switch on. Stub.
export class InstantSync {
  async watch(workspaceId: string): Promise<void> { throw stub(); }
  async unwatch(workspaceId: string): Promise<void> { throw stub(); }
  /** Bring the watcher set in line with the running containers. */
  async reconcile(runningWorkspaceIds: string[]): Promise<void> { throw stub(); }
  async stop(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
