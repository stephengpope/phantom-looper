// WorkspaceWatcher — "tell me when a file in this directory changes",
// backed by a child process running @parcel/watcher (its inotify backend
// dies on EINTR; the child is restarted, the API is not). Stub.
export class WorkspaceWatcher {
  watch(workspaceId: string, dir: string, onChange: () => void): void { throw stub(); }
  unwatch(workspaceId: string): void { throw stub(); }
  stop(): void { throw stub(); }
}
const stub = () => new Error('stub');
