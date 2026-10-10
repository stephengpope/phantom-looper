// SessionNotes — the system's one door into a conversation: one-line facts
// for a session's agent, written into its record at its NEXT turn's start,
// without a turn being started for them. A detached command exiting, a git
// sync that landed or conflicted. They
// are NOT user messages: a person's words wait in the client SDK's queue.
// A note is written ahead of the turn's own words,
// and once written it is part of the conversation — it is never handed back,
// whatever happens to the turn.
// In-memory by design: a note is a courtesy, never the record — the fact it
// reports lives in its own row (a dead list after a restart loses nothing
// the commands table does not still say).

/** Per-session cap: a session that never gets a turn must not grow the map
 *  for ever. Oldest drop first — the newest fact is the one that matters. */
const MAX_PER_SESSION = 50;

export class SessionNotes {
  private bySession = new Map<string, string[]>();

  add(sessionId: string, text: string): void {
    const list = this.bySession.get(sessionId) ?? [];
    list.push(text);
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.bySession.set(sessionId, list);
  }

  /** Is this exact note already waiting for the session? A repeating fact
   *  (instant sync's notes) waits once until a turn takes it. */
  has(sessionId: string, text: string): boolean {
    return this.bySession.get(sessionId)?.includes(text) ?? false;
  }

  /** Take every note waiting for a session (one consumer gets each — the
   *  session lock guarantees turns start one at a time). Turn-start is the
   *  only caller. */
  drain(sessionId: string): string[] {
    const list = this.bySession.get(sessionId);
    if (!list?.length) return [];
    this.bySession.delete(sessionId);
    return list;
  }
}
