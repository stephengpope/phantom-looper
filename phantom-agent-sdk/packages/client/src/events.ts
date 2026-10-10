// What a client can watch. Optional to listen to — errors and notices are
// NOT events: they go to the two required handlers (onError, onNotice), so
// nothing important depends on someone remembering to subscribe.
import type { ModelMessage } from 'ai';
import type { StreamPart, TurnResult } from './turn.js';
import type { TokenTotals } from './transcript.js';
import type { PhantomError } from './errors.js';
import type { Provider, Reasoning } from './model/llmConfig.js';
import type { HandoffTarget } from './session.js';

export interface AgentEvents {
  /** The turn is running: what it opened with, and the model it runs on. */
  'turn-start': { texts: string[]; model: { provider: Provider; model: string; reasoning: Reasoning | null } };
  'part': StreamPart;
  /** Lines were appended and acknowledged. */
  'step': { messages: readonly ModelMessage[]; usage: Readonly<TokenTotals> };
  /** Queued text was taken: it rode into a model call, or drives the next run. */
  'user-message': { texts: string[] };
  /** Words not sent: they drove a run that failed or was stopped before the
   *  model answered them, so they were never written. They are back at the
   *  front of the queue, waiting for the next message — this says which
   *  and why, for the app to show. Words that RODE a call are written when
   *  taken and never come back; neither do the server's notes. */
  'returned': { texts: string[]; error: PhantomError };
  'tool-error': { name: string; error: unknown };
  'turn-end': TurnResult;
  /** The turn left this agent at a step boundary (disconnect): the named
   *  session runner drives it from here; this agent is free. Watch the
   *  session feed for the rest. */
  'handed-off': { runner: HandoffTarget };
  /** Someone else added to the conversation since this agent last looked
   *  (another client's turn, the server's queued user messages); it was
   *  read again before the turn ran. `messages` is the conversation now;
   *  `from` → `now` the record stamps before and after; `added` the
   *  messages gained, in order, when the gain is plain appends — a host
   *  whose screen matched `from` draws just those; null = redraw whole. */
  'reloaded': { messages: readonly ModelMessage[]; from: string | null; now: string | null; added: readonly ModelMessage[] | null };
}

type Listener<T> = (payload: T) => void;

export class Emitter {
  private listeners = new Map<keyof AgentEvents, Set<Listener<never>>>();

  on<E extends keyof AgentEvents>(event: E, listener: Listener<AgentEvents[E]>): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return () => { set.delete(listener); };
  }

  /** A listener that throws is a client bug; it is reported through
   *  `onListenerError`, never swallowed and never allowed to break the turn. */
  emit<E extends keyof AgentEvents>(event: E, payload: AgentEvents[E], onListenerError: (error: unknown) => void): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try { (listener as Listener<AgentEvents[E]>)(payload); }
      catch (error) { onListenerError(error); }
    }
  }
}
