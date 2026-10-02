// Settings — every behavioural knob: defaults live in code, the table holds
// only overrides, resolved default → global → project. Credentials are
// settings stored encrypted; secrets are user-named encrypted values. The
// settings REGISTRY is the door: the SDK registers its own definitions at
// boot and user space's come in through config.settings; from then on
// nothing tells them apart. Stub.
import type { SettingDefinition } from '../doors.js';

/** Where a value may come from. */
export type SettingSource = 'default' | 'global' | 'project';
/** One key's value at every layer, and which layer won. */
export interface SettingLayers { default: unknown; global?: unknown; project?: unknown; value: unknown; source: SettingSource }
/** What resolution is relative to: nothing (global only) or a project. */
export interface SettingScope { projectId?: string }

export class Settings {
  // ── the registry ──────────────────────────────────────────────────────
  /** Add definitions. A key already registered is an error (no shadowing). */
  register(definitions: SettingDefinition[]): void { throw stub(); }
  /** The definition behind a key, or undefined. */
  definitionOf(key: string): SettingDefinition | undefined { throw stub(); }
  /** Is `key` registered? */
  isRegistered(key: string): boolean { throw stub(); }
  /** Why `value` is not acceptable for `key`, or null when it is. */
  validate(key: string, value: unknown): string | null { throw stub(); }

  // ── reading ───────────────────────────────────────────────────────────
  /** One key's winning value for the scope. */
  async resolve<T = unknown>(key: string, scope?: SettingScope): Promise<T> { throw stub(); }
  /** Several keys' winning values, one query. */
  async resolveMany(keys: readonly string[], scope?: SettingScope): Promise<Record<string, unknown>> { throw stub(); }
  /** One key's value and which layer it came from. */
  async resolveWithSource(key: string, scope?: SettingScope): Promise<{ value: unknown; source: SettingSource }> { throw stub(); }
  /** Every key with all its layers — what a settings editor renders. */
  async layersForScope(scope?: SettingScope): Promise<Record<string, SettingLayers>> { throw stub(); }

  // ── writing ───────────────────────────────────────────────────────────
  /** Set or clear (null) keys at one layer. Validated; a project-only or
   *  global-only key at the wrong layer is refused. Publishes to SettingsEvents. */
  async writeAtScope(layer: 'global' | 'project', scopeName: string, patch: Record<string, unknown>, by?: string): Promise<void> { throw stub(); }
  /** Delete every row of a scope — a project being removed. */
  async deleteScope(scopeName: string): Promise<void> { throw stub(); }

  // ── credentials (API keys, tokens — registered with `secret: true`) ───
  /** The decrypted value, project layer first, or undefined when unset. */
  async credential(key: string, scope?: SettingScope): Promise<string | undefined> { throw stub(); }
  /** Is a credential set at exactly this scope? (never the value) */
  async hasCredentialAt(key: string, scopeName: string): Promise<boolean> { throw stub(); }

  // ── secrets (user-named encrypted values the agent reads by name) ─────
  async listSecrets(scopeNames?: string[]): Promise<Array<{ scope: string; name: string; description: string }>> { throw stub(); }
  async readSecret(name: string, scopeNames?: string[]): Promise<string | undefined> { throw stub(); }
  async writeSecret(scopeName: string, name: string, description: string, value?: string): Promise<void> { throw stub(); }
  async deleteSecret(scopeName: string, name: string): Promise<void> { throw stub(); }

  /** A Clock in the scope's timezone setting. */
  async clockFor(scope?: SettingScope): Promise<unknown /* Clock */> { throw stub(); }
}
const stub = () => new Error('stub');
