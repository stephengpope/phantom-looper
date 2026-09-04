// The session title's wiring — fills ./sessionTitle.ts (the document). No
// prompt text lives here.
import { fill } from '../template.js';
import { SYSTEM, NAME_THE_SESSION } from './sessionTitle.js';

/** The one-shot pair for a generateText call: the titler's system prompt and
 *  the request with the conversation's recent messages attached. */
export function titleRequest(recentMessages: string): { system: string; prompt: string } {
  return { system: fill(SYSTEM, {}), prompt: fill(NAME_THE_SESSION, { recentMessages }) };
}
