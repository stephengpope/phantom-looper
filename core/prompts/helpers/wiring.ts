// The session title's wiring — fills ./sessionTitle.ts (the document). No
// prompt text lives here.
import { fill } from '../template.js';
import { SYSTEM, NAME_THE_SESSION } from './sessionTitle.js';

/** The user-message selection the titler names. */
export interface TitleContext {
  contextNote: string;
  userMessages: string;
}

/** The one-shot pair for a generateText call: the titler's system prompt and
 *  the request with the selected user messages attached. */
export function titleRequest(context: TitleContext): { system: string; prompt: string } {
  return { system: fill(SYSTEM, {}), prompt: fill(NAME_THE_SESSION, {
    contextNote: context.contextNote,
    userMessages: context.userMessages,
  }) };
}
