// Settings change notifications. The event carries no values: the server is
// the only source of truth, so every listener re-reads /settings instead of
// adopting a second copy that took a different route.
import { EventEmitter } from 'node:events';

export interface SettingsChanged {
  event: 'settings_changed';
  /** The store scope written: global, workspace:<id>, or session:<id>. */
  scope: string;
  /** The writer's client id, so a window can ignore the echo of its own save. */
  client?: string;
}

export class SettingsEvents {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }

  publish(scope: string, client?: string): void {
    this.emitter.emit('changed', { event: 'settings_changed', scope, ...(client ? { client } : {}) });
  }

  subscribe(fn: (e: SettingsChanged) => void): () => void {
    this.emitter.on('changed', fn);
    return () => { this.emitter.off('changed', fn); };
  }
}
