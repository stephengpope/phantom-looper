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
import type { PullProgress } from '../core/update.js';
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

/** One JSON line of Docker's pull stream. */
interface PullEvent { status?: string; id?: string; progressDetail?: { current?: number; total?: number } }

/** A pull's progress as two percentages that only ever climb: bytes
 *  downloaded, then layers unpacked. Docker pulls in two phases — every layer
 *  is downloaded, then each is unpacked — and its stream differs by image
 *  store (both measured against a live daemon):
 *
 *    * legacy (graph driver): "Pulling fs layer" for each layer to fetch,
 *      "Downloading" with byte totals, "Download complete", then "Extracting"
 *      with byte totals that START OVER (same id), "Pull complete". Layers
 *      already here say only "Already exists".
 *    * containerd store (Docker 28+ default): "Pulling fs layer" for EVERY
 *      layer, then "Already exists" or a byte-counted download; "Extracting"
 *      carries elapsed seconds, no total; "Pull complete" for every layer.
 *
 *  So bytes are the one honest download measure on both, and unpacking is
 *  counted in layers (an "Extracting" number is bytes on one store and
 *  seconds on the other). Download reads 100 only once every layer is
 *  downloaded — three download at a time, so bytes can hit 100% of what is
 *  KNOWN while layers still wait — and unpack counts the layers that had to
 *  be fetched (existing layers never unpack on the legacy store).
 *
 *  A layer's size is only learned when its download starts, so the byte
 *  ratio's denominator grows mid-pull and the true figure can dip; the
 *  reported one is a high-water mark — "at least this much" — that holds
 *  until the real figure passes it again. */
export class PullTracker {
  private layers = new Set<string>();      // "Pulling fs layer"
  private existing = new Set<string>();    // "Already exists"
  private downloaded = new Set<string>();  // "Download complete" | "Already exists"
  private unpacked = new Set<string>();    // "Pull complete"
  private bytes = new Map<string, { current: number; total: number }>();
  private downloadHigh = 0;

  /** Fold one stream line in; true when it changed the picture. */
  see(e: PullEvent): boolean {
    const id = e.id;
    if (!id) return false;
    switch (e.status) {
      case 'Pulling fs layer': this.layers.add(id); return true;
      case 'Already exists': this.existing.add(id); this.downloaded.add(id); return true;
      case 'Downloading': {
        const total = e.progressDetail?.total;
        if (!total) return false;
        this.bytes.set(id, { current: e.progressDetail?.current ?? 0, total });
        return true;
      }
      case 'Download complete': {
        this.downloaded.add(id);
        const b = this.bytes.get(id);
        if (b) b.current = b.total;
        return true;
      }
      case 'Pull complete': this.downloaded.add(id); this.unpacked.add(id); return true;
      default: return false;
    }
  }

  progress(): PullProgress {
    const allDownloaded = this.layers.size > 0 && [...this.layers].every((id) => this.downloaded.has(id));
    let current = 0, total = 0;
    for (const b of this.bytes.values()) { current += b.current; total += b.total; }
    const ratio = allDownloaded ? 100 : total > 0 ? Math.min(99, Math.floor((current / total) * 100)) : 0;
    const download = this.downloadHigh = Math.max(this.downloadHigh, ratio);
    const toUnpack = [...this.layers].filter((id) => !this.existing.has(id));
    const done = toUnpack.filter((id) => this.unpacked.has(id)).length;
    const unpack = toUnpack.length > 0 ? Math.round((done / toUnpack.length) * 100) : allDownloaded ? 100 : 0;
    return { download, unpack };
  }
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

  /** Pull `image`, reporting download and unpack percentages as layers
   *  arrive. Resolves when Docker's stream ends — which is after every layer
   *  is unpacked and the tag is written: the image is on disk and usable.
   *  Attaches to an identical pull already running (its progress is reported
   *  too). */
  pull(image: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    const inflight = this.pulls.get(image);
    if (inflight) return inflight;
    const p = (this.removal ?? Promise.resolve())
      .then(() => this.stream(image, onProgress))
      .then(() => log.info({ image }, 'image pulled'))
      .finally(() => this.pulls.delete(image));
    this.pulls.set(image, p);
    return p;
  }

  private stream(image: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (e: Error | null, stream: NodeJS.ReadableStream) => {
        if (e) return reject(e);
        const tracker = new PullTracker();
        this.docker.modem.followProgress(
          stream,
          (err: Error | null) => (err ? reject(err) : resolve()),
          (event: PullEvent) => { if (onProgress && tracker.see(event)) onProgress(tracker.progress()); },
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
    // An image a container still uses (running or stopped) cannot go —
    // Docker refuses. Skip it instead of asking and logging the refusal on
    // every sweep; it goes on the sweep after its last container does.
    const inUse = new Set((await this.docker.listContainers({ all: true })).map((c) => c.ImageID));
    const stale = new Set<string>();
    for (const img of await this.docker.listImages()) {
      if (inUse.has(img.Id)) continue;
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
