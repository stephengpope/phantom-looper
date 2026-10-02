// Upgrader — this backend's self-update: check the release source for a
// newer version on an interval, notify; on request pull the api and
// session images at the new tag, run the installer, restart the stack,
// streaming progress to the caller. One update at a time. Stub.
export interface UpgradeEvent { step: string; detail?: string; done?: boolean; error?: string }

export class Upgrader {
  /** The newest published version, and whether it is ahead of this one. */
  async check(): Promise<{ current: string; latest: string; behind: boolean }> { throw stub(); }
  /** Run the upgrade to `tag`, streaming events; resolves when the restart is issued. */
  upgrade(tag: string, options: { restartAnyway?: boolean }, onEvent: (event: UpgradeEvent) => void): { done: Promise<void>; stop(): void } { throw stub(); }
  /** The periodic check. */
  start(): void { throw stub(); }
  stop(): void { throw stub(); }
  /** The compose stack's logs and a service restart — the housekeeping the update needs. */
  async logs(query: { service?: string; lines?: number; grep?: string }): Promise<{ service: string; text: string; truncated?: boolean }> { throw stub(); }
  async restart(service: string): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
