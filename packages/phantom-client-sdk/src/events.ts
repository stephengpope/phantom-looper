// What a client can watch. Optional to listen to — errors and notices are
// NOT events: they go to the two required handlers (onError, onNotice), so
// nothing important depends on someone remembering to subscribe.
import type { ModelMessage } from 'ai';
import type { StreamPart, TurnResult, TurnUsage } from './turn.js';

export interface AgentEvents {
  'turn-start': { texts: string[] };
  'part': StreamPart;
  /** Lines were appended and acknowledged. */
  'step': { messages: ModelMessage[]; usage: TurnUsage };
  /** Queued text rode into a model call. */
  'user-message': { texts: string[] };
  'tool-error': { name: string; error: unknown };
  'turn-end': TurnResult;
  'compacted': { removed: number; summary: string };
  /** Someone else added to the transcript since this agent last looked; it
   *  was read again before the turn ran. `messages` is the conversation now. */
  'reloaded': { messages: readonly ModelMessage[] };
}

type Listener<T> = (payload: T) => void;

export class Emitter {
  private listeners = new Map<keyof AgentEvents, Set<Listener<never>>>();

  on<E extends keyof AgentEvents>(event: E, fn: Listener<AgentEvents[E]>): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  /** A listener that throws is a client bug; it is reported through
   *  `onListenerError`, never swallowed and never allowed to break the turn. */
  emit<E extends keyof AgentEvents>(event: E, payload: AgentEvents[E], onListenerError: (e: unknown) => void): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { (fn as Listener<AgentEvents[E]>)(payload); }
      catch (e) { onListenerError(e); }
    }
  }
}
