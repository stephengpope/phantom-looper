// UserMessageQueue — one-line facts slipped in front of a session's
// agent on its NEXT turn, without a turn being started for them. Sources are
// things that happened behind the conversation's back — a detached command
// exiting, a file dropped onto the cli window landing in the scratch pad.
// In-memory by design: a queued message is a courtesy, never the record —
// the fact it reports lives in its own row (a dead queue after a restart
// loses nothing the commands table does not still say).
//
// One home (backend.userMessageQueue), one door out: turn-start drains the
// session's queue into the record before the turn's first model call,
// whichever client runs the turn. So a queued message lands in the
// conversation exactly once.

/** Per-session cap: a session that never gets a turn must not grow the map
 *  for ever. Oldest drop first — the newest fact is the one that matters. */
const MAX_PER_SESSION = 50;

export class UserMessageQueue {
  private bySession = new Map<string, string[]>();

  push(sessionId: string, text: string): void {
    const list = this.bySession.get(sessionId) ?? [];
    list.push(text);
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.bySession.set(sessionId, list);
  }

  /** Is this exact text already waiting for the session? A repeating fact
   *  (instant sync's notes) is queued once until a turn takes it. */
  has(sessionId: string, text: string): boolean {
    return this.bySession.get(sessionId)?.includes(text) ?? false;
  }

  /** Take everything pending for a session (atomic splice — one consumer
   *  gets each message; the session lock guarantees turns come one at a time). */
  drain(sessionId: string): string[] {
    const list = this.bySession.get(sessionId);
    if (!list?.length) return [];
    this.bySession.delete(sessionId);
    return list;
  }

  /** Put drained messages BACK (ahead of anything newer) when the turn that
   *  took them failed before they were saved — a failed turn must not eat
   *  them. */
  restore(sessionId: string, texts: string[]): void {
    if (!texts.length) return;
    const list = [...texts, ...(this.bySession.get(sessionId) ?? [])];
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.bySession.set(sessionId, list);
  }
}
