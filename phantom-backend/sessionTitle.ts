// The session title's model call (PhantomBackendConfig.transitional.writeTitle):
// the ASSISTANT's model names the session from the selected user messages.
// The cadence, the selection and the write-back are the SDK's (SessionTitler).
import { titleRequest } from '../core/prompts/helpers/wiring.js';
import type { TitleContext } from 'phantom-backend-sdk';
import { oneShot, type OneShotDeps } from './oneShot.js';
import { logger, errStr } from 'phantom-backend-sdk';

const log = logger('titler');
const TRIES = 2;

export const writeTitle = (deps: OneShotDeps) => async (sessionId: string, context: TitleContext): Promise<string | null> => {
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const title = await oneShot(deps, 'assistant', { type: 'title', sessionId }, titleRequest(context));
      if (title.trim()) return title;
    } catch (e) {
      log.warn({ session: sessionId, attempt, err: errStr(e) }, 'session title attempt failed');
      // HTTP failures were already retried inside the model call; these tries are for a model that ANSWERED nonsense.
      if ((e as { statusCode?: number }).statusCode !== undefined) break;
    }
  }
  return null;
};
