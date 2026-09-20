// Images — THE one object that pulls and removes docker images in this
// process. Both the update (api + session image at the new tag) and the
// workspace container's first-use pull come through `pull`; the disk sweep's
// cleanup comes through `removeOlderThan`. They never overlap:
//
//   * a removal is REFUSED while any pull is in flight (it simply runs on the
//     next sweep), and a pull started while a removal runs waits for it.
//
// Why this is a wall and not a courtesy: on Docker's containerd image store
// an in-flight pull holds a LEASE on its half-downloaded layers — the only
// thing keeping the garbage collector off them. `docker image prune`
// (dangling images) deletes every pull lease before it prunes (moby
// daemon/containerd/image_prune.go), so a prune during a pull destroys the
// pull's layers under it and the download dies. There is therefore NO
// dangling prune here at all; the only removal is by tag, of releases older
// than the one in use, and only when nothing is pulling.
import type Docker from 'dockerode';
import { logger, errStr } from './log.js';

const log = logger('images');

/** `vX.Y.Z` as a comparable triple; anything else (latest, dev, a digest)
 *  is not a release and never ordered. */
const releaseOf = (tag: string): [number, number, number] | null => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const olderRelease = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

/** `repo:tag` split at the tag colon (a registry port colon sits before the
 *  last slash and is not it). */
const splitRef = (ref: string): { repo: string; tag: string } => {
  const i = ref.lastIndexOf(':');
  return i > ref.lastIndexOf('/') ? { repo: ref.slice(0, i), tag: ref.slice(i + 1) } : { repo: ref, tag: '' };
};

interface LayerProgress { current: number; total: number }

/** Aggregate download percentage over the layers seen so far. A layer that
 *  goes straight to "Download complete" without progress events is too small
 *  to matter — it does not affect the percentage. */
function aggregatePercent(layers: Map<string, LayerProgress>): number {
  let current = 0, total = 0;
  for (const l of layers.values()) { current += l.current; total += l.total; }
  return total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
}

export class Images {
  /** One pull per image at a time — concurrent callers share it instead of
   *  each streaming the same layers. */
  private pulls = new Map<string, Promise<void>>();
  /** The removal in progress, if any — pulls wait on it. */
  private removal: Promise<void> | null = null;

  constructor(private readonly docker: Docker) {}

  inFlight(): number { return this.pulls.size; }

  /** Is `image` on this machine? Rejects (404) when not. */
  inspect(image: string): Promise<unknown> { return this.docker.getImage(image).inspect(); }

  /** Pull `image`, reporting the aggregate download percentage as layers
   *  arrive. Resolves when the pull is complete. Attaches to an identical
   *  pull already running (its progress is reported too). */
  pull(image: string, onPercent?: (pct: number) => void): Promise<void> {
    const inflight = this.pulls.get(image);
    if (inflight) return inflight;
    const p = (this.removal ?? Promise.resolve())
      .then(() => this.stream(image, onPercent))
      .then(() => log.info({ image }, 'image pulled'))
      .finally(() => this.pulls.delete(image));
    this.pulls.set(image, p);
    return p;
  }

  private stream(image: string, onPercent?: (pct: number) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (e: Error | null, stream: NodeJS.ReadableStream) => {
        if (e) return reject(e);
        const layers = new Map<string, LayerProgress>();
        this.docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : resolve()),
          (event: { id?: string; progressDetail?: { current?: number; total?: number } }) => {
            if (!onPercent || !event.id || !event.progressDetail?.total) return;
            layers.set(event.id, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total });
            onPercent(aggregatePercent(layers));
          },
        );
      });
    });
  }

  /** Remove the tags of releases OLDER than each of `currents` (the images in
   *  use, `repo:vX.Y.Z`) — a release pulls a new tag and nothing else ever
   *  removes the old ones. Never a newer tag (an update in flight pulled it),
   *  never `latest` or any non-release tag, and nothing for a current whose
   *  tag is not a release itself (no order to compare by). A tag Docker
   *  refuses (in use by a container) is logged and left.
   *
   *  Refused outright while any pull is in flight — the pull's layers are
   *  the one thing this must never touch, so the sweep waits its turn. */
  async removeOlderThan(currents: string[]): Promise<void> {
    if (this.pulls.size > 0) {
      log.info({ pulling: [...this.pulls.keys()] }, 'image cleanup skipped — a pull is in flight');
      return;
    }
    if (this.removal) return this.removal;
    this.removal = this.removeStale(currents).finally(() => { this.removal = null; });
    return this.removal;
  }

  private async removeStale(currents: string[]): Promise<void> {
    const live = currents
      .map(splitRef)
      .flatMap(({ repo, tag }) => { const r = releaseOf(tag); return r ? [{ repo, release: r }] : []; });
    const stale = new Set<string>();
    for (const img of await this.docker.listImages()) {
      for (const ref of img.RepoTags ?? []) {
        const { repo, tag } = splitRef(ref);
        const release = releaseOf(tag);
        if (!release) continue;
        if (live.some((c) => c.repo === repo && olderRelease(release, c.release))) stale.add(ref);
      }
    }
    for (const tag of stale) {
      await this.docker.getImage(tag).remove()
        .then(() => log.info({ image: tag }, 'old image removed'))
        .catch((e) => log.warn({ image: tag, err: errStr(e) }, 'could not remove old image'));
    }
  }
}
