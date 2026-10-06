// The server's half of prompt building. fill() and firstLineOf() live in the
// client SDK (pure text, bundled by agents and the cli alike); this is the
// one piece that needs the server's clock.
import type { Clock } from '../lib/clock.js';

/** A frozen prompt piece plus today's date in the builder's zone —
 *  recomputed at every agent build (launch, resume, model change), so the
 *  stored text never moves. */
export function withCurrentDate(instructions: string, clock: Clock): string {
  return `${instructions}\n\nCurrent date: ${clock.date()}.`;
}
