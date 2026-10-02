// SettingsEvents — "these keys changed in this scope", never the values:
// the server is the one source, listeners re-read. Stub.
export interface SettingsChanged { scope: string; keys: string[]; by?: string }

export class SettingsEvents {
  publish(scope: string, keys: string[], by?: string): void { throw stub(); }
  subscribe(listener: (change: SettingsChanged) => void): () => void { throw stub(); }
}
const stub = () => new Error('stub');
