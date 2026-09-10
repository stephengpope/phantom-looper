// Passive notices: one-line facts a session's agent should see on its NEXT
// turn, without a turn being started for them (a detached command exiting is
// the first source). In-memory by design: a notice is a courtesy, never the
// record — the fact it reports lives in its own row (a dead notice after a
// restart loses nothing the commands table does not still say).
//
// One home (ctx.notices), two doors out: server-side turns drain it inside
// runCodingTurn, a cli window drains it over POST /sessions/:id/notices/drain
// as its send starts. What is drained joins the turn's messages and is saved
// with the transcript, so a notice lands in the conversation exactly once.

/** Per-session cap: a session that never gets a turn must not grow the map
 *  for ever. Oldest drop first — the newest exit is the one that matters. */
const MAX_PER_SESSION = 50;

export class Notices {
  private bySession = new Map<string, string[]>();

  push(sessionId: string, text: string): void {
    const list = this.bySession.get(sessionId) ?? [];
    list.push(text);
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.bySession.set(sessionId, list);
  }

  /** Take everything pending for a session (atomic splice — one consumer
   *  gets each notice; the session lock guarantees turns come one at a time). */
  drain(sessionId: string): string[] {
    const list = this.bySession.get(sessionId);
    if (!list?.length) return [];
    this.bySession.delete(sessionId);
    return list;
  }

  /** Put drained notices BACK (ahead of anything newer) when the turn that
   *  took them failed before they were saved — a failed turn must not eat
   *  them. */
  restore(sessionId: string, texts: string[]): void {
    if (!texts.length) return;
    const list = [...texts, ...(this.bySession.get(sessionId) ?? [])];
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.bySession.set(sessionId, list);
  }
}
