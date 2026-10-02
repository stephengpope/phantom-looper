// Images — THE one object that pulls and removes docker images in this
// process: a pull never races a removal, a removal never takes an image a
// container uses or this release needs. Stub.
export interface PullProgress { current: number; total: number; layers: number }

export class Images {
  async inspect(image: string): Promise<{ id: string; size: number } | null> { throw stub(); }
  /** Pull, reporting layer progress; concurrent pulls of one image share the work. */
  async pull(image: string, onProgress?: (progress: PullProgress) => void): Promise<void> { throw stub(); }
  /** Remove every image of ours older than the releases named, unless a container uses it. */
  async removeOlderThan(currentReleases: string[]): Promise<void> { throw stub(); }
  pullsInFlight(): number { throw stub(); }
}
const stub = () => new Error('stub');
