// The record client for one session: the lines held, their count on the
// server, the server's stamp for them, the totals, and the one sequential
// writer.
//
// Writing: POST /sessions/:id/transcript/append { after, deliveryId, lines }.
// The server writes only if it has exactly `after` lines AND has not seen
// `deliveryId`. A lost reply → resend → already seen → no duplicate. A lost
// request → still `after` → written. Delivery k+1 is never sent before k is
// answered, so the count held here always equals the server's.
//
// Others write it too (another client, the server — one at a time, under
// the session lock). `stamp` is the server's last-changed mark for the copy
// held here; taking the lock answers the server's current one, and a turn
// that sees them differ reads the lines after its own (`catchUp`) first.
import type { PhantomBackend } from './backend.js';
import { PhantomError } from './errors.js';
import { addTotals, lineId, parseLines, usageTotals, type TokenTotals, type TranscriptLine } from './transcript.js';

interface TranscriptReply { data: string | null; lines?: number; updated_at?: string | null }

export class SessionRecord {
  #count: number;
  #stamp: string | null;
  #totals: TokenTotals;
  #chain: Promise<void> = Promise.resolve();
  readonly lines: TranscriptLine[];

  private constructor(private readonly backend: PhantomBackend, private readonly sessionId: string,
    lines: TranscriptLine[], count: number, stamp: string | null) {
    this.lines = lines;
    this.#count = count;
    this.#stamp = stamp;
    this.#totals = usageTotals(lines);
  }

  /** Read the whole record from the server. */
  static async load(backend: PhantomBackend, sessionId: string): Promise<SessionRecord> {
    const r = await backend.call<TranscriptReply>('GET', `/sessions/${sessionId}/transcript`);
    const lines = parseLines(r.data ?? '');
    return new SessionRecord(backend, sessionId, lines, r.lines ?? lines.length, r.updated_at ?? null);
  }

  /** The server's last-changed mark for the copy held here. */
  get stamp(): string | null { return this.#stamp; }
  /** The tokens the record accounts for, whoever wrote them. */
  get usage(): Readonly<TokenTotals> { return this.#totals; }

  /** Someone else wrote: read only the lines after ours and add them. */
  async catchUp(signal?: AbortSignal): Promise<TranscriptLine[]> {
    const r = await this.backend.call<TranscriptReply>('GET',
      `/sessions/${this.sessionId}/transcript?after=${this.#count}`, undefined, { signal });
    const more = parseLines(r.data ?? '');
    this.#hold(more);
    this.#count = r.lines ?? this.#count + more.length;
    this.#stamp = r.updated_at ?? null;
    return more;
  }

  /** Append lines. Resolves when the server acknowledged them; rejects with
   *  transcript_conflict (someone else wrote) or transcript_write_failed. */
  append(lines: TranscriptLine[]): Promise<void> {
    if (!lines.length) return this.#chain;
    const next = this.#chain.then(() => this.#send(lines));
    // The chain survives a failure so a later append can still run (the
    // turn decides it is over); the failure is handed to THIS caller.
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #hold(lines: TranscriptLine[]): void {
    this.lines.push(...lines);
    this.#totals = addTotals(this.#totals, usageTotals(lines));
  }

  async #send(lines: TranscriptLine[]): Promise<void> {
    const after = this.#count;
    let r: { lines: number; applied: boolean; updated_at?: string | null };
    try {
      r = await this.backend.call('POST', `/sessions/${this.sessionId}/transcript/append`, { after, deliveryId: lineId(), lines });
    } catch (e) {
      if (e instanceof PhantomError && e.code === 'transcript_conflict') throw e;
      throw new PhantomError('transcript_write_failed', `transcript append failed: ${(e as Error).message}`, { cause: e });
    }
    if (r.lines !== after + lines.length) {
      throw new PhantomError('transcript_conflict',
        `transcript has ${r.lines} lines on the server, expected ${after + lines.length} — another writer moved it`);
    }
    this.#count = r.lines;
    this.#stamp = r.updated_at ?? null;
    this.#hold(lines);
  }
}
