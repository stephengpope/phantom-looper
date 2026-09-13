// The loop row's one owner. A loop is the pairing written once when a card
// enters the looper: this coder session, this supervisor session. Immutable;
// old rows are the permanent record of who reviewed what. The CURRENT loop for
// a card is its newest row.
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { loops, type LoopRow } from './db/schema.js';
import { newId } from '../core/ids.js';

export class Loops {
  constructor(private readonly db: Db) {}

  /** The pairing, written ONCE when a card enters the loop. */
  async create(workspaceId: string, card: number, codingSessionId: string, supervisorSessionId: string): Promise<LoopRow> {
    const id = newId();
    await this.db.insert(loops).values({ id, workspaceId, card, codingSessionId, supervisorSessionId });
    return (await this.db.select().from(loops).where(eq(loops.id, id)))[0];
  }

  /** The current loop for a card: the newest row. Old rows are history. */
  async current(workspaceId: string, card: number): Promise<LoopRow | undefined> {
    const rows = await this.db.select().from(loops)
      .where(and(eq(loops.workspaceId, workspaceId), eq(loops.card, card)))
      .orderBy(desc(loops.createdAt)).limit(1);
    return rows[0];
  }

  /** The loop a session sits in, either seat — which card it belongs to. */
  async of(sessionId: string): Promise<LoopRow | undefined> {
    const rows = await this.db.select().from(loops)
      .where(or(eq(loops.codingSessionId, sessionId), eq(loops.supervisorSessionId, sessionId)))
      .orderBy(desc(loops.createdAt)).limit(1);
    return rows[0];
  }

  /** The loop whose CODING seat this session is — the card it is building. A
   *  supervisor session answers nothing here. */
  async byCodingSession(sessionId: string): Promise<LoopRow | undefined> {
    const rows = await this.db.select().from(loops)
      .where(eq(loops.codingSessionId, sessionId))
      .orderBy(desc(loops.createdAt)).limit(1);
    return rows[0];
  }

  /** Each coding session's card, for a batch — the work-state refresh names
   *  the card on its board event. */
  async cardsOf(codingSessionIds: string[]): Promise<Map<string, number>> {
    if (!codingSessionIds.length) return new Map();
    const rows = await this.db.select({ card: loops.card, codingSessionId: loops.codingSessionId })
      .from(loops).where(inArray(loops.codingSessionId, codingSessionIds));
    return new Map(rows.map((l) => [l.codingSessionId, l.card]));
  }

  /** Every card's CURRENT loop in a workspace — the newest row per card, the
   *  same ordering `current` uses. One query for the whole board. */
  async latestPerCard(workspaceId: string): Promise<LoopRow[]> {
    const rows = await this.db.select().from(loops)
      .where(eq(loops.workspaceId, workspaceId))
      .orderBy(loops.card, desc(loops.createdAt));
    const seen = new Set<number>();
    return rows.filter((l) => (seen.has(l.card) ? false : (seen.add(l.card), true)));
  }
}
