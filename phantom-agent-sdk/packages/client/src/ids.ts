// Session and repo identifiers: ULID, lowercased. One id becomes a git branch
// name, a directory name, a Docker label, and a log field — ULID is safe in all
// four and sorts by creation time, which keeps every listing readable.
import { ulid, decodeTime } from 'ulid';

export function newId(): string {
  return ulid().toLowerCase();
}

/** When a ULID was minted. Used by the pool to age slots out without a marker
 *  file — the timestamp rides in the name itself. */
export function idTime(id: string): number {
  return decodeTime(id.toUpperCase());
}
