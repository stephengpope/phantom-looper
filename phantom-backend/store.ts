// THE settings store. One table, one resolution rule, for settings and secrets
// alike.
//
// A row is (scope, namespace, key). `scope` is which layer: `global`,
// `workspace:<id>`, `session:<id>`, most specific winning. `namespace` is
// which world: `general` — the declared settings, every key declared in code
// (settings.ts) — or `secret` — user-named secrets, free names. Every read
// here filters by namespace, so a secret named `github_token` can never
// shadow the credential of the same name.
//
// A secret differs from a setting in exactly one way — where its bytes sit. The
// table's CHECKs make plaintext-in-a-secret and encrypted-not-a-secret
// unrepresentable, so this file never has to remember which is which.
//
// Only `dropKey` deletes. Nothing else in this file removes a row, and nothing
// outside it should: "absent from a patch" and "empty" both arrive constantly
// for reasons that have nothing to do with wanting rid of something. Null is
// the one thing that means delete, and it is never stored.
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { settings } from './db/schema.js';
import { encrypt, decrypt } from './crypto.js';
import { logger } from './log.js';

const log = logger('settings');

export const GLOBAL = 'global';
export const workspaceScope = (id: string) => `workspace:${id}`;
export const sessionScope = (id: string) => `session:${id}`;

const GENERAL = 'general';
const SECRET_NS = 'secret';

/** One stored value, decrypted. `secret` says which column it came out of. */
export interface Stored { value: unknown; secret: boolean }

/** Every row at the scopes asked for, as scope -> key -> value. ONE query:
 *  resolving 30 settings must not be 30 round trips.
 *
 *  `key` null means PLAIN VALUES ONLY — secret rows are skipped, not decrypted.
 *  Resolving `spare_clones` has no business touching a credential, and passing a
 *  placeholder key instead made every ordinary settings read try to decrypt
 *  every stored secret and log a warning per row (found by running it). */
export async function readStore(
  db: Db, key: Buffer | null, scopes: string[] = [GLOBAL],
): Promise<Map<string, Map<string, Stored>>> {
  const out = new Map<string, Map<string, Stored>>();
  for (const s of scopes) out.set(s, new Map());
  const rows = await db.select().from(settings).where(and(
    inArray(settings.scope, scopes), eq(settings.namespace, GENERAL)));
  for (const r of rows) {
    // A row that will not decrypt is KEPT and reported, never treated as unset —
    // unset is what a caller deletes, and one bad row must not lose the rest.
    let value: unknown;
    if (r.secret) {
      if (!key) continue;
      try { value = decrypt(key, Buffer.from(r.valueEnc as Buffer)); }
      catch { log.warn({ scope: r.scope, key: r.key }, 'stored secret could not be decrypted — kept, not deleted'); continue; }
    } else value = r.value;
    out.get(r.scope)?.set(r.key, { value, secret: r.secret });
  }
  return out;
}

/** One value at one scope, or undefined. */
export async function readKey(
  db: Db, key: Buffer, k: string, scope = GLOBAL,
): Promise<Stored | undefined> {
  const rows = await db.select().from(settings).where(and(
    eq(settings.scope, scope), eq(settings.namespace, GENERAL), eq(settings.key, k)));
  if (!rows.length) return undefined;
  const r = rows[0];
  if (!r.secret) return { value: r.value, secret: false };
  try { return { value: decrypt(key, Buffer.from(r.valueEnc as Buffer)), secret: true }; }
  catch { return undefined; }
}

/** Write one value at a scope. `secret` puts it in the encrypted column — and a
 *  secret is always a string, because that is what a cipher takes. */
export async function putScoped(
  db: Db, key: Buffer, scope: string, k: string, value: unknown, secret: boolean,
): Promise<void> {
  const row = secret
    ? { value: null, valueEnc: encrypt(key, typeof value === 'string' ? value : JSON.stringify(value)), secret: true }
    : { value: value as never, valueEnc: null, secret: false };
  await db.insert(settings)
    .values({ scope, namespace: GENERAL, key: k, ...row })
    .onConflictDoUpdate({
      target: [settings.scope, settings.namespace, settings.key],
      set: { ...row, updatedAt: new Date() },
    });
}

/** Write one value at the global scope. */
export async function putKey(
  db: Db, key: Buffer, k: string, value: unknown, secret: boolean,
): Promise<void> {
  return putScoped(db, key, GLOBAL, k, value, secret);
}

/** The ONLY delete (secrets go through dropSecret, same rule). */
export async function dropKey(db: Db, k: string, scope = GLOBAL): Promise<void> {
  await db.delete(settings).where(and(
    eq(settings.scope, scope), eq(settings.namespace, GENERAL), eq(settings.key, k)));
}

// --- secrets — the `secret` namespace ---------------------------------------
// One row per secret: token encrypted in value_enc, description in plain
// value. Listing reads the plain column only and never decrypts.

export interface SecretMeta { name: string; description: string; scope: string }

/** Every secret at the scopes asked for — names and descriptions, NEVER
 *  values. Ordered global-first, then by name, so a merged list is stable. */
export async function listSecrets(db: Db, scopes: string[] = [GLOBAL]): Promise<SecretMeta[]> {
  const rows = await db.select().from(settings).where(and(
    inArray(settings.scope, scopes), eq(settings.namespace, SECRET_NS)));
  return sortSecrets(rows.map(secretMeta));
}

/** EVERY secret, every layer — the cli's list, which offers every workspace
 *  as a save target and so must show every workspace's rows. `scope` is the
 *  raw scope string (`global` / `workspace:<id>`). */
export async function listAllSecrets(db: Db): Promise<SecretMeta[]> {
  const rows = await db.select().from(settings).where(eq(settings.namespace, SECRET_NS));
  return sortSecrets(rows.map(secretMeta));
}

const secretMeta = (r: { key: string; scope: string; value: unknown }): SecretMeta => ({
  name: r.key, scope: r.scope,
  description: String((r.value as { description?: unknown } | null)?.description ?? ''),
});
const sortSecrets = (s: SecretMeta[]) => s.sort((a, b) =>
  (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === GLOBAL ? -1 : a.scope.localeCompare(b.scope)));

/** One secret's value, resolved most-specific-first over the scopes given
 *  (pass [GLOBAL, workspaceScope(id)] — workspace wins). undefined = no such
 *  secret, or it would not decrypt. */
export async function readSecretValue(
  db: Db, key: Buffer, name: string, scopes: string[] = [GLOBAL],
): Promise<string | undefined> {
  const rows = await db.select().from(settings).where(and(
    inArray(settings.scope, scopes), eq(settings.namespace, SECRET_NS), eq(settings.key, name)));
  // Most specific wins: later in `scopes` = more specific, same as computeLayers.
  const byScope = new Map(rows.map((r) => [r.scope, r]));
  for (const s of [...scopes].reverse()) {
    const r = byScope.get(s);
    if (!r) continue;
    try { return decrypt(key, Buffer.from(r.valueEnc as Buffer)); }
    catch { log.warn({ scope: s, name }, 'stored secret could not be decrypted — kept, not deleted'); return undefined; }
  }
  return undefined;
}

/** Create or overwrite one secret at ONE scope. */
export async function putSecret(
  db: Db, key: Buffer, scope: string, name: string, description: string, value: string,
): Promise<void> {
  const row = { value: { description } as never, valueEnc: encrypt(key, value), secret: true };
  await db.insert(settings)
    .values({ scope, namespace: SECRET_NS, key: name, ...row })
    .onConflictDoUpdate({
      target: [settings.scope, settings.namespace, settings.key],
      set: { ...row, updatedAt: new Date() },
    });
}

/** Delete one secret at ONE scope. Returns whether a row was there. */
export async function dropSecret(db: Db, scope: string, name: string): Promise<boolean> {
  const gone = await db.delete(settings).where(and(
    eq(settings.scope, scope), eq(settings.namespace, SECRET_NS), eq(settings.key, name)))
    .returning({ key: settings.key });
  return gone.length > 0;
}
