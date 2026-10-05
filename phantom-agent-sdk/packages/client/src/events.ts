// What a client can watch. Optional to listen to — errors and notices are
// NOT events: they go to the two required handlers (onError, onNotice), so
// nothing important depends on someone remembering to subscribe.
import type { ModelMessage } from 'ai';
import type { StreamPart, TurnResult } from './turn.js';
import type { TokenTotals } from './transcript.js';
import type { Provider, Reasoning } from './model/llmConfig.js';

export interface AgentEvents {
  /** The turn is running: what it opened with, and the model it runs on. */
  'turn-start': { texts: string[]; model: { provider: Provider; model: string; reasoning: Reasoning | null } };
  'part': StreamPart;
  /** Lines were appended and acknowledged. */
  'step': { messages: readonly ModelMessage[]; usage: Readonly<TokenTotals> };
  /** Queued text rode into a model call. */
  'user-message': { texts: string[] };
  'tool-error': { name: string; error: unknown };
  'turn-end': TurnResult;
  /** Someone else added to the transcript since this agent last looked; it
   *  was read again before the turn ran. `messages` is the conversation now. */
  'reloaded': { messages: readonly ModelMessage[] };
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
