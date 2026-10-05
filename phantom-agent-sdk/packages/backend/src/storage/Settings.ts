// Settings — every behavioural knob, resolved default → global row →
// organization row → user row → project row (lib/scopes.ts LAYERS: the
// last row found wins). Defaults live in the REGISTRY, in code; the table
// holds only overrides. Read at the point of use, never cached at boot: a change must
// take effect without a restart or the API lies.
//
// ONE store for settings and secrets — a row is (scope, namespace, key).
// `namespace` separates the declared settings world ('general' — every
// registered key; a credential's value sits in value_enc, everything else's
// in value) from user-named secrets ('secret' — free names, token in
// value_enc, description in plain value). This is the only file that
// touches the table; every reader resolves through it, every writer writes
// through it, and a write announces its scope on the settings feed.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Drizzle } from './Database.js';
import { settings } from './schema.js';
import { GLOBAL, LAYERS, scopeNames, type Layer, type OverridableLayer, type SettingScope } from '../lib/scopes.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { Clock } from '../lib/clock.js';
import { logger } from '../lib/log.js';
import type { SettingDefinition } from '../doors.js';
import type { ModelCatalog } from '../agents/ModelCatalog.js';
import type { SettingsEvents } from '../agents/SettingsEvents.js';

const log = logger('settings');

/** Where a value came from — the layer's own name. */
export type SettingSource = 'default' | Layer;
export type { SettingScope } from '../lib/scopes.js';

/** One setting with its LAYERS exposed, not just the winner — what a client
 *  needs to render an editor (VS Code's inspect(), git's --show-origin).
 *  A layer the scope did not name is null. */
export interface SettingLayers {
  default: unknown;
  global: unknown;
  organization: unknown;
  user: unknown;
  project: unknown;
  value: unknown;
  source: SettingSource;
}

/** The layers plus what a screen needs: the description, the rendering
 *  meta, where it may be overridden (`overridableAt`; `overridable` is the
 *  project's answer, what the cli reads), whether it is a credential. One
 *  shape for settings and credentials, so a client files both with the
 *  same code. A credential's values are always null — a token is never
 *  shown back; its `source` says where one is stored. */
export type SettingEntry = SettingLayers & {
  description: string;
  meta: SettingMeta;
  overridable: boolean;
  overridableAt: OverridableLayer[];
  secret?: boolean;
};
export interface SettingMeta {
  type: SettingDefinition['type'];
  label: string;
  group: string;
  subgroup?: string;
  nullable?: boolean;
  choices?: readonly string[];
  choiceLabels?: Readonly<Record<string, string>>;
  suggestions?: readonly string[];
  unit?: SettingDefinition['unit'];
  min?: number;
  max?: number;
  /** A credential's: which LLM provider its key authenticates. */
  provider?: string;
}

/** A write that cannot be stored, with the API's error code already chosen. */
export class SettingsWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SettingsWriteError'; }
}

/** A secret as listed — name and description, NEVER the value. */
export interface SecretMeta { name: string; description: string; scope: string }

const GENERAL = 'general';
const SECRET_NS = 'secret';
/** scope -> key -> stored value (decrypted where it was encrypted). */
type ByScope = Map<string, Map<string, unknown>>;
/** The stored value at each layer the scope names; absent = no row. */
type RawLayers = Partial<Record<Layer, unknown>>;
const EMPTY_LAYERS = { global: null, organization: null, user: null, project: null };

const secretMeta = (row: { key: string; scope: string; value: unknown }): SecretMeta => ({
  name: row.key, scope: row.scope,
  description: String((row.value as { description?: unknown } | null)?.description ?? ''),
});
const sortSecrets = (secrets: SecretMeta[]) => secrets.sort((a, b) =>
  (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === GLOBAL ? -1 : a.scope.localeCompare(b.scope)));

export class Settings {
  readonly #definitions = new Map<string, SettingDefinition>();

  constructor(
    private readonly database: Drizzle,
    private readonly encryptionKey: Buffer,
    /** The catalog the "newest model" default reads. */
    private readonly modelCatalog: ModelCatalog,
    /** The settings feed; absent in tests with no listeners. */
    private readonly events?: SettingsEvents,
  ) {}

  // ── the registry ──────────────────────────────────────────────────────

  /** Add definitions. A key already registered is an error (no shadowing);
   *  a nullable setting with a non-null default is an error (null always
   *  means "clear", never a stored value). Registration order is screen
   *  order. */
  register(definitions: readonly SettingDefinition[]): void {
    for (const definition of definitions) {
      if (this.#definitions.has(definition.key)) throw new Error(`setting '${definition.key}' is registered twice`);
      if (definition.secret && (definition.type !== 'string' || definition.default !== null)) {
        throw new Error(`setting '${definition.key}': a credential is a string with a null default`);
      }
      if (definition.before && this.#definitions.has(definition.before)) {
        // Rebuild the map with this key just before its anchor: the map's
        // order IS the screen order.
        const entries = [...this.#definitions.entries()];
        const at = entries.findIndex(([key]) => key === definition.before);
        entries.splice(at, 0, [definition.key, definition]);
        this.#definitions.clear();
        for (const [key, value] of entries) this.#definitions.set(key, value);
        continue;
      }
      this.#definitions.set(definition.key, definition);
    }
  }

  definitionOf(key: string): SettingDefinition | undefined { return this.#definitions.get(key); }
  isRegistered(key: string): boolean { return this.#definitions.has(key); }
  /** Every registered key, in registration order. */
  keys(): string[] { return [...this.#definitions.keys()]; }
  isCredential(key: string): boolean { return this.#definitions.get(key)?.secret === true; }
  /** The credential holding one provider's API key, or undefined for a
   *  provider that holds no key here (openai-codex reads its own login). */
  credentialKeyForProvider(provider: string): string | undefined {
    for (const definition of this.#definitions.values()) if (definition.secret && definition.provider === provider) return definition.key;
    return undefined;
  }
  /** The layers below global this key may be set at. A project-only key: the project's. */
  overridableAt(key: string): OverridableLayer[] {
    const definition = this.#definitions.get(key);
    if (!definition) return [];
    return definition.projectOnly ? ['project'] : [...(definition.overridableAt ?? [])];
  }
  isOverridableAt(key: string, layer: OverridableLayer): boolean { return this.overridableAt(key).includes(layer); }
  isProjectOverridable(key: string): boolean { return this.isOverridableAt(key, 'project'); }
  isGlobalSettable(key: string): boolean { return this.#definitions.get(key)?.projectOnly !== true; }

  /** Validate one value against its definition. null when fine, else why.
   *  The table is not typed per key, so this is the only thing between a
   *  typo and a setting that explodes at its point of use hours later. */
  validate(key: string, value: unknown): string | null {
    const definition = this.#definitions.get(key);
    if (!definition) return `unknown setting: ${key}`;
    if (value === null) return `${key}: null clears the key (it is never a stored value)`;
    if (definition.choices) {
      return typeof value === 'string' && definition.choices.includes(value)
        ? null : `${key} must be one of: ${definition.choices.join(', ')}`;
    }
    if (definition.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number`;
      if (definition.min !== undefined && value < definition.min) return `${key} must be >= ${definition.min}`;
      if (definition.max !== undefined && value > definition.max) return `${key} must be <= ${definition.max}`;
      return null;
    }
    if (definition.type === 'boolean') return typeof value === 'boolean' ? null : `${key} must be true or false`;
    if (typeof value !== 'string') return `${key} must be a string`;
    if (definition.pattern && !definition.pattern.test(value)) return `${key} is not a valid ${definition.label}: "${value}"`;
    if (definition.check) return definition.check(value);
    return null;
  }

  /** The rendering meta a client reads off the wire. */
  metaOf(key: string): SettingMeta {
    const definition = this.requireDefinition(key);
    return {
      type: definition.type, label: definition.label, group: definition.group,
      ...(definition.subgroup ? { subgroup: definition.subgroup } : {}),
      ...(definition.default === null ? { nullable: true } : {}),
      ...(definition.choices ? { choices: definition.choices } : {}),
      ...(definition.choiceLabels ? { choiceLabels: definition.choiceLabels } : {}),
      ...(definition.suggestions ? { suggestions: definition.suggestions } : {}),
      ...(definition.unit ? { unit: definition.unit } : {}),
      ...(definition.min !== undefined ? { min: definition.min } : {}),
      ...(definition.max !== undefined ? { max: definition.max } : {}),
      ...(definition.provider ? { provider: definition.provider } : {}),
    };
  }

  private requireDefinition(key: string): SettingDefinition {
    const definition = this.#definitions.get(key);
    if (!definition) throw new Error(`unknown setting: ${key}`);
    return definition;
  }

  // ── the table, privately ──────────────────────────────────────────────

  /** Every row at the scopes asked for, as scope -> key -> value. ONE
   *  query: resolving 30 settings must not be 30 round trips.
   *  `credentials` false means PLAIN VALUES ONLY — encrypted rows are
   *  skipped, not decrypted. `onlyKey` narrows to one key: a credential
   *  read decrypts that one and no other. */
  private async readStore(scopes: string[], credentials: boolean, onlyKey?: string): Promise<ByScope> {
    const out: ByScope = new Map();
    for (const scope of scopes) out.set(scope, new Map());
    const rows = await this.database.select().from(settings).where(and(
      inArray(settings.scope, scopes), eq(settings.namespace, GENERAL),
      ...(onlyKey ? [eq(settings.key, onlyKey)] : [])));
    for (const row of rows) {
      // A row that will not decrypt is KEPT and reported, never treated as
      // unset — unset is what a caller deletes, and one bad row must not
      // lose the rest.
      let value: unknown;
      if (row.valueEnc) {
        if (!credentials) continue;
        try { value = decrypt(this.encryptionKey, Buffer.from(row.valueEnc)); }
        catch { log.warn({ scope: row.scope, key: row.key }, 'stored credential could not be decrypted — kept, not deleted'); continue; }
      } else value = row.value;
      out.get(row.scope)?.set(row.key, value);
    }
    return out;
  }

  private async writeRow(scopeName: string, key: string, value: unknown): Promise<void> {
    const row = this.isCredential(key)
      ? { value: null, valueEnc: encrypt(this.encryptionKey, value as string) }
      : { value: value as never, valueEnc: null };
    await this.database.insert(settings)
      .values({ scope: scopeName, namespace: GENERAL, key, ...row })
      .onConflictDoUpdate({ target: [settings.scope, settings.namespace, settings.key], set: { ...row, updatedAt: new Date() } });
  }

  private async deleteRow(scopeName: string, key: string): Promise<void> {
    await this.database.delete(settings).where(and(eq(settings.scope, scopeName), eq(settings.namespace, GENERAL), eq(settings.key, key)));
  }

  // ── resolution ────────────────────────────────────────────────────────

  /** The scopes to read for a context, in chain order. Every read goes through here. */
  private scopesFor(scope: SettingScope): string[] {
    return Object.values(scopeNames(scope));
  }

  private rawLayers(byScope: ByScope, scope: SettingScope, key: string): RawLayers {
    const raw: RawLayers = {};
    for (const [layer, scopeName] of Object.entries(scopeNames(scope)) as [Layer, string][]) {
      const value = byScope.get(scopeName)?.get(key);
      if (value !== undefined) raw[layer] = value;
    }
    return raw;
  }

  /** THE precedence rule, written once: the default, then every layer in
   *  chain order; the last row wins. Row PRESENCE decides at every level —
   *  null is never stored, so "there is a row" and "there is an override"
   *  are the same statement. */
  private computeLayers(key: string, raw: RawLayers): SettingLayers {
    const definition = this.requireDefinition(key);
    let value: unknown = definition.default;
    let source: SettingSource = 'default';
    for (const layer of LAYERS) if (raw[layer] !== undefined) { value = raw[layer]; source = layer; }
    return { default: definition.default, ...EMPTY_LAYERS, ...Object.fromEntries(LAYERS.map((layer) => [layer, raw[layer] ?? null])), value, source };
  }

  /** The layers with the provider rules applied (doors.ts:
   *  `boundToProvider`, `defaultsToLatestModel`). A layer's own provider
   *  row, when it names a different provider than the layers above it,
   *  cuts those layers' model/endpoint out of the chain — a project on
   *  openai must not inherit the organization's claude id. */
  private layersOf(key: string, byScope: ByScope, scope: SettingScope): SettingLayers {
    const definition = this.requireDefinition(key);
    const raw = this.rawLayers(byScope, scope, key);
    const layers = this.computeLayers(key, raw);
    if (!definition.boundToProvider) return layers;
    const providerRaw = this.rawLayers(byScope, scope, definition.boundToProvider);
    const own = { ...layers };
    let value: unknown = definition.default;
    let source: SettingSource = 'default';
    let providerAbove: unknown = this.requireDefinition(definition.boundToProvider).default;
    for (const layer of LAYERS) {
      if (providerRaw[layer] !== undefined && providerRaw[layer] !== providerAbove) { value = definition.default; source = 'default'; }
      if (providerRaw[layer] !== undefined) providerAbove = providerRaw[layer];
      if (raw[layer] !== undefined) { value = raw[layer]; source = layer; }
    }
    own.value = value; own.source = source;
    if (!definition.defaultsToLatestModel || own.value != null) return own;
    const latest = this.modelCatalog.latestFor(typeof providerAbove === 'string' ? providerAbove : null);
    return { ...own, default: latest, value: latest };
  }

  // ── reading ───────────────────────────────────────────────────────────

  async resolveWithSource(key: string, scope: SettingScope = {}): Promise<{ value: unknown; source: SettingSource }> {
    const byScope = await this.readStore(this.scopesFor(scope), false);
    const { value, source } = this.layersOf(key, byScope, scope);
    return { value, source };
  }

  async resolve<T = unknown>(key: string, scope: SettingScope = {}): Promise<T> {
    return (await this.resolveWithSource(key, scope)).value as T;
  }

  async resolveMany<K extends string>(keys: readonly K[], scope: SettingScope = {}): Promise<Record<K, unknown>> {
    const byScope = await this.readStore(this.scopesFor(scope), false);
    const out = {} as Record<K, unknown>;
    for (const key of keys) out[key] = this.layersOf(key, byScope, scope).value;
    return out;
  }

  /** Every registered setting with its layers, plus every credential with
   *  its SOURCE only — what a settings editor renders from one call. */
  async layersForScope(scope: SettingScope = {}): Promise<Record<string, SettingEntry>> {
    const names = scopeNames(scope);
    const byScope = await this.readStore(Object.values(names), false);
    const present = await this.credentialPresence(Object.values(names));
    const out: Record<string, SettingEntry> = {};
    for (const [key, definition] of this.#definitions) {
      const screen = { description: definition.description, meta: this.metaOf(key),
        overridable: this.isProjectOverridable(key), overridableAt: this.overridableAt(key) };
      if (definition.secret) {
        // Where a token is stored: the deepest layer with a row among those
        // the scope names and the key may be set at.
        let source: SettingSource = 'default';
        for (const [layer, scopeName] of Object.entries(names) as [Layer, string][]) {
          if (layer !== 'global' && !this.isOverridableAt(key, layer)) continue;
          if (present.get(scopeName)?.has(key)) source = layer;
        }
        out[key] = { default: null, ...EMPTY_LAYERS, value: null, source, ...screen, secret: true };
        continue;
      }
      out[key] = { ...this.layersOf(key, byScope, scope), ...screen };
    }
    return out;
  }

  /** A Clock in the `timezone` setting — the project's own zone when one
   *  is given, else the global one. THE door for anything that shows or
   *  reads a date. */
  async clockFor(scope: SettingScope = {}): Promise<Clock> {
    return new Clock(await this.resolve<string>('timezone', scope));
  }

  // ── credentials ───────────────────────────────────────────────────────

  /** A credential, most specific layer first — the ONE path that decrypts
   *  one. undefined = unset at every layer. */
  async credential(key: string, scope: SettingScope = {}): Promise<string | undefined> {
    if (!this.isCredential(key)) throw new Error(`${key} is not a credential`);
    const byScope = await this.readStore(this.scopesFor(scope), true, key);
    const { value } = this.computeLayers(key, this.rawLayers(byScope, scope, key));
    return typeof value === 'string' && value.length ? value : undefined;
  }

  /** Every credential's stored value at every layer the scope names,
   *  decrypted — the settings editor's view (flagged secret there). */
  async credentialLayers(scope: SettingScope = {}): Promise<Record<string, Record<Layer, string | null>>> {
    const byScope = await this.readStore(this.scopesFor(scope), true);
    const out: Record<string, Record<Layer, string | null>> = {};
    for (const [key, definition] of this.#definitions) {
      if (!definition.secret) continue;
      const raw = this.rawLayers(byScope, scope, key);
      out[key] = Object.fromEntries(LAYERS.map((layer) => [layer, typeof raw[layer] === 'string' ? raw[layer] : null])) as Record<Layer, string | null>;
    }
    return out;
  }

  /** Which credentials have a row at which scope — presence only, nothing
   *  decrypted. ONE query for every credential on a settings screen. */
  private async credentialPresence(scopes: string[]): Promise<Map<string, Set<string>>> {
    const rows = await this.database.select({ scope: settings.scope, key: settings.key }).from(settings).where(and(
      inArray(settings.scope, scopes), eq(settings.namespace, GENERAL), isNotNull(settings.valueEnc)));
    const out = new Map<string, Set<string>>();
    for (const row of rows) { if (!out.has(row.scope)) out.set(row.scope, new Set()); out.get(row.scope)!.add(row.key); }
    return out;
  }

  /** Is a credential set at exactly this scope (not inherited)? */
  async hasCredentialAt(key: string, scopeName: string): Promise<boolean> {
    return (await this.credentialPresence([scopeName])).get(scopeName)?.has(key) ?? false;
  }

  // ── writing ───────────────────────────────────────────────────────────

  /** THE settings writer. Every route that changes a setting — at any
   *  layer — goes through this one validation + store path, so a second
   *  door cannot accept a value the first refused. null clears; it is
   *  never stored. Announces the scope when anything was written. Returns
   *  the keys written. `by` is the writer's client id, so its own window
   *  ignores the echo. */
  async writeAtScope(layer: Layer, scopeName: string, patch: Record<string, unknown>, by?: string): Promise<string[]> {
    const values = { ...patch };
    const unknown = Object.keys(values).filter((key) => !this.isRegistered(key));
    if (unknown.length) throw new SettingsWriteError('unknown_setting', `unknown settings: ${unknown.join(', ')}`);
    const invalid = Object.entries(values)
      .filter(([key, value]) => value !== null && !this.isCredential(key))
      .map(([key, value]) => this.validate(key, value))
      .filter((problem): problem is string => problem !== null);
    if (invalid.length) throw new SettingsWriteError('invalid_setting', invalid.join('; '));
    for (const [key, value] of Object.entries(values)) {
      if (this.isCredential(key) && value !== null && typeof value !== 'string') {
        throw new SettingsWriteError('invalid_args', `${key} must be a string to be stored encrypted`);
      }
      if (layer === 'global') {
        if (!this.isGlobalSettable(key)) throw new SettingsWriteError('not_overridable', `${key} is a fact about one project — set it there`);
        continue;
      }
      if (!this.isOverridableAt(key, layer)) throw new SettingsWriteError('not_overridable', `${key} cannot be set per ${layer}`);
    }
    if (layer !== 'global') await this.providerFirst(scopeName, values);
    const entries = Object.entries(values);
    for (const [key, value] of entries) {
      if (value === null) await this.deleteRow(scopeName, key);
      else await this.writeRow(scopeName, key, value);
    }
    if (entries.length) this.events?.publish(scopeName, entries.map(([key]) => key), by);
    return entries.map(([key]) => key);
  }

  /** The PROVIDER-FIRST rule on one patch below global: a setting bound to
   *  a provider needs that layer's own provider row — already stored, or in
   *  this patch — and clearing the provider clears what is bound to it,
   *  added to the patch so they go out on the same write. */
  private async providerFirst(scopeName: string, values: Record<string, unknown>): Promise<void> {
    const sets = (key: string) => values[key] !== undefined && values[key] !== null;
    const bound = Object.keys(values).filter((key) => sets(key) && this.#definitions.get(key)?.boundToProvider);
    for (const key of bound) {
      const providerKey = this.#definitions.get(key)!.boundToProvider!;
      if (sets(providerKey)) continue;
      const stored = await this.readStore([scopeName], false, providerKey);
      if (stored.get(scopeName)?.get(providerKey) === undefined) {
        throw new SettingsWriteError('provider_first', `set this layer's ${this.requireDefinition(providerKey).label} before its ${this.requireDefinition(key).label}`);
      }
    }
    for (const [providerKey, value] of Object.entries(values)) {
      if (value !== null) continue;
      for (const definition of this.#definitions.values()) if (definition.boundToProvider === providerKey) values[definition.key] = null;
    }
  }

  /** A whole scope goes — a project, organization or user that no longer exists. Both namespaces: its overrides and its secrets. */
  async deleteScope(scopeName: string): Promise<void> {
    await this.database.delete(settings).where(eq(settings.scope, scopeName));
  }

  // ── secrets — the `secret` namespace ──────────────────────────────────
  // One row per secret: token encrypted in value_enc, description in plain
  // value. Listing reads the plain column only and never decrypts.

  /** Every secret at the scopes asked for — names and descriptions, NEVER values. Global-first, then by name. */
  async listSecrets(scopeNames: string[] = [GLOBAL]): Promise<SecretMeta[]> {
    const rows = await this.database.select().from(settings).where(and(inArray(settings.scope, scopeNames), eq(settings.namespace, SECRET_NS)));
    return sortSecrets(rows.map(secretMeta));
  }

  /** EVERY secret, every layer — a list that offers every project as a save target. */
  async listAllSecrets(): Promise<SecretMeta[]> {
    const rows = await this.database.select().from(settings).where(eq(settings.namespace, SECRET_NS));
    return sortSecrets(rows.map(secretMeta));
  }

  /** One secret's value, most-specific-first over the scopes given (in
   *  chain order, as `scopeNames` lists them — the last wins). undefined =
   *  no such secret, or it would not decrypt. */
  async readSecret(name: string, scopeNames: string[] = [GLOBAL]): Promise<string | undefined> {
    const rows = await this.database.select().from(settings).where(and(
      inArray(settings.scope, scopeNames), eq(settings.namespace, SECRET_NS), eq(settings.key, name)));
    const byScope = new Map(rows.map((row) => [row.scope, row]));
    for (const scopeName of [...scopeNames].reverse()) {
      const row = byScope.get(scopeName);
      if (!row) continue;
      try { return decrypt(this.encryptionKey, Buffer.from(row.valueEnc as Buffer)); }
      catch { log.warn({ scope: scopeName, name }, 'stored secret could not be decrypted — kept, not deleted'); return undefined; }
    }
    return undefined;
  }

  /** Create or overwrite one secret at ONE scope. No `value` = keep the
   *  stored one and change only the description. False when there was no
   *  value to keep. */
  async writeSecret(scopeName: string, name: string, description: string, value?: string): Promise<boolean> {
    const where = and(eq(settings.scope, scopeName), eq(settings.namespace, SECRET_NS), eq(settings.key, name));
    if (value === undefined) {
      const kept = await this.database.update(settings).set({ value: { description } as never, updatedAt: new Date() }).where(where).returning({ key: settings.key });
      return kept.length > 0;
    }
    const row = { value: { description } as never, valueEnc: encrypt(this.encryptionKey, value) };
    await this.database.insert(settings)
      .values({ scope: scopeName, namespace: SECRET_NS, key: name, ...row })
      .onConflictDoUpdate({ target: [settings.scope, settings.namespace, settings.key], set: { ...row, updatedAt: new Date() } });
    return true;
  }

  /** Delete one secret at ONE scope. Whether a row was there. */
  async deleteSecret(scopeName: string, name: string): Promise<boolean> {
    const gone = await this.database.delete(settings).where(and(
      eq(settings.scope, scopeName), eq(settings.namespace, SECRET_NS), eq(settings.key, name))).returning({ key: settings.key });
    return gone.length > 0;
  }
}
