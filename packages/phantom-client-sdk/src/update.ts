// The server update's progress stream — the events POST /update emits and
// the one way every client (cli, Telegram) words them. The shapes and the
// wording live here so the two clients cannot drift.
//
// Lifecycle, in order:
//   pulling     per image: download %, then unpack % (Docker downloads every
//               layer, then unpacks them — two phases, two numbers)
//   pulled      both images fully on disk
//   installing  one line of the installer's own output (updater/apply.sh),
//               relayed as it prints — copying files, pinning the tag,
//               restarting the stack
//   restarting  the api is going down (rarely seen: the restart usually cuts
//               the stream first — a client treats a dropped stream after
//               `pulled` as this)
//   error       the update stopped; `message` says why
//   heartbeat   keeps the connection alive; ignore

export interface PullProgress { download: number; unpack: number }

export type UpdateEvent =
  | ({ event: 'pulling'; image: string } & PullProgress)
  | { event: 'pulled' }
  | { event: 'installing'; message: string }
  | { event: 'restarting' }
  | { event: 'error'; message: string }
  | { event: 'heartbeat' };

/** The one progress line for the pull: the download phase until every image
 *  is downloaded, then the unpack phase — the number never runs backwards
 *  within a phase, and the label says which phase it is. */
export function pullLine(images: Record<string, PullProgress>): string {
  const downloading = Object.values(images).some((p) => p.download < 100);
  const parts = Object.entries(images)
    .map(([img, p]) => `${img} ${downloading ? p.download : p.unpack}%`).join('  ');
  return `${downloading ? 'Downloading' : 'Unpacking'} server images:  ${parts}`;
}
