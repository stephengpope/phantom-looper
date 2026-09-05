// One settings screen, reached by three commands that each name their own
// scope — there is no menu of scopes to walk through first.
//
//   /model       local: provider, model, reasoning, steps per turn, your key
//   /connection  local: the api url and token
//   /settings    the server's own settings, which apply to everyone
//
// Two more scopes exist and are deliberately NOT here: one workspace's own
// values (WorkspaceSettings.tsx, `e` on a row in /workspace) and the server's
// secrets (Keys.tsx, /keys). This screen marks the settings a workspace can
// differ on with ↯ so the server-wide list points at them, but it never edits
// them — changing something for everyone and changing it for one workspace
// must not be two rows apart in the same list.
//
// Local and server settings never share a screen. The server has a git_fixer_model (the Git Fixer's)
// (git auto-push's conflict-fix model) and it is NOT your chat model; one list
// holding both invites exactly that mistake. The local screens also never make a network call, because you edit
// the connection precisely when the server is unreachable.
import { Text } from './Text.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULTS, DESCRIPTIONS, META, CONFIG_PATH, PROVIDER_KEY, REMOTE_DEFAULTS,
  mask, visibleKeys, hiddenKeyCount, isLocalKey,
  type ConfigKey, type ConfigValue,
} from '../config.js';
import { resolveLocal, localValues, setLocal, clearLocal } from '../local.js';
import { makeSettings } from '../settings.js';
import { SelectList, type Choice } from './SelectList.js';
import { human, labelFor, type WireMeta } from '../settingLabels.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import { PROVIDERS } from '../config.js';

export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

interface ServerSetting { value: unknown; source: string; description: string;
  /** Whether one workspace can differ on it — see WorkspaceSettings.tsx. */
  overridable?: boolean;
  /** Credentials — never rendered here. /keys is their one screen. */
  secret?: boolean;
  meta: WireMeta }

type View =
  | { at: 'local'; showAllKeys?: boolean }
  | { at: 'api' }
  | { at: 'edit'; scope: 'local' | 'api'; key: string; spec: EditSpec };

type Group = 'model' | 'server' | 'voice';
const GROUPS: Array<[Group, string]> = [
  ['model', 'model'], ['server', 'server'], ['voice', 'voice'],
];

export function Settings({ api, onClose, onLocalChange, configPath = CONFIG_PATH, startAt, groups, title, suggestions, onOpenRow }: {
  api: Api;
  onClose: () => void;
  /** Fired after any local write so the app can rebuild the agent. */
  onLocalChange?: (key: ConfigKey) => void;
  configPath?: string;
  /** Which scope this command opens. */
  startAt: 'local' | 'api';
  /** Narrow the local list to these groups — /model shows only `model`. */
  groups?: ReadonlyArray<Group>;
  /** Overrides the header when the screen is a shortcut rather than /settings. */
  title?: string;
  /** Values to offer for a key that has no fixed choices — the device names
   *  the voice sidecar reported, for the mic and speaker rows. Read live, so a
   *  list that arrives while the picker is open shows up in it. */
  suggestions?: Partial<Record<ConfigKey, string[]>>;
  /** Fired when a local row's editor opens — the voice rows use it to re-scan
   *  devices at the one moment a fresh list matters. */
  onOpenRow?: (key: ConfigKey) => void;
}) {
  const [view, setView] = useState<View>({ at: startAt });
  const [tick, setTick] = useState(0);              // forces a re-read after a write
  const [server, setServer] = useState<Record<string, ServerSetting> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  // The row the list left from — the editor replaces the list, and when the
  // list comes back its cursor returns HERE, not to the top. Also kept across
  // the `a` toggle, which remounts the list with more rows.
  const [last, setLast] = useState<string | undefined>();

  // Opening the screen is a READ, and so is every write's aftermath. The screen
  // shows what is stored right now — never a copy the app has been carrying
  // since launch, which is what left the Assistant running on the settings it
  // was born with.
  const settings = useMemo(() => makeSettings(api), [api]);
  const [remote, setRemote] = useState<Record<string, ConfigValue> | null>(null);
  useEffect(() => {
    if (startAt !== 'local') return;
    let stale = false;
    void settings.read()
      .then((r: Record<string, ConfigValue>) => { if (!stale) setRemote(r); })
      .catch((e: unknown) => { if (!stale) setNotice(`server unreachable: ${(e as Error).message}`); });
    return () => { stale = true; };
  }, [settings, startAt, tick]);

  // The two homes, merged for display. Each row still says which it came from,
  // which is what makes one screen over two stores safe to read.
  const { config: localCfg, error: fileError } = resolveLocal(configPath);
  const plain = { ...(remote ?? {}), ...localValues(configPath) } as Record<ConfigKey, ConfigValue>;
  const config = { ...Object.fromEntries(Object.entries(remote ?? {}).map(
    ([k, v]) => [k, { value: v, source: 'server' as const }])), ...localCfg } as
    Record<ConfigKey, { value: ConfigValue; source: string; envVar?: string }>;

  const loadServer = useCallback(async () => {
    setBusy(true);
    try { setServer(await settings.all() as unknown as Record<string, ServerSetting>); }
    catch (e) { setNotice(`server unreachable: ${(e as Error).message}`); setServer({}); }
    finally { setBusy(false); }
  }, [settings]);

  useEffect(() => { if (view.at === 'api' && !server) void loadServer(); }, [view, server, loadServer]);

  // The model catalog is the SERVER's (GET /models): one list for every
  // client and for the "newest model" default. Read when a model row's editor
  // opens; a server that cannot answer leaves the row free-text.
  const loadModels = useCallback(async (provider: string): Promise<CatalogModel[]> => {
    try {
      const r = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models?: CatalogModel[] };
      return Array.isArray(r?.models) ? r.models : [];
    } catch { return []; }
  }, [api]);
  /** The spec, plus the catalog for a model row and the keyed providers for a
   *  provider row — the two shapes every model-ish row takes, on both screens. */
  const finishSpec = async (key: string, spec: EditSpec, values: Record<string, unknown>): Promise<EditSpec> => {
    const providerRow = providerChoices(key, spec.choices, values);
    if (providerRow) return { ...spec, ...providerRow };
    const provider = providerForModelRow(key, values);
    if (!provider) return spec;
    const models = await loadModels(provider);
    if (!models.length) return spec;
    return { ...spec,
      suggestions: models.map((m) => m.id),
      suggestionLabels: Object.fromEntries(models.map((m) => [m.id, m.name])),
      note: spec.note ?? `${provider} models, newest first · or type any model id · empty = the newest` };
  };

  // ONE writer, routing on where the key LIVES — not on which screen you are
  // looking at. Local is a file and answers immediately; everything else is a
  // request to the server and can fail, which the notice says out loud rather
  // than silently keeping the old value on screen.
  const writeLocal = (key: ConfigKey, v: ConfigValue) => {
    if (isLocalKey(key)) {
      const bad = v === null ? clearLocal(key, configPath) : setLocal(key, v, configPath);
      setNotice(bad ?? undefined);
      if (!bad) { setTick((t) => t + 1); onLocalChange?.(key); }
      return;
    }
    void (async () => {
      try {
        await settings.write(key, v);
        setNotice(undefined);
        setTick((t) => t + 1);     // re-read: show what was STORED, not what we sent
        onLocalChange?.(key);      // and let the app re-read too
      } catch (e) { setNotice(`could not save: ${(e as Error).message}`); }
    })();
  };

  // Escape is owned by whatever is focused — the list closes the screen, the
  // editor returns to the list. Handling it here as well fired both, so a
  // single press closed the editor AND the screen. The letter shortcuts go
  // through the list's onKey for the same reason, and because only the list
  // knows which row is highlighted.

  // Until the read lands there is nothing true to show. Rendering the rows
  // early painted them from the code defaults with no source beside them —
  // which is the same lie as a cache, just a shorter one.
  if (view.at === 'local' && remote === null) {
    return (
      <Screen title={title ?? 'settings'} footer={[{ key: 'esc', does: 'close' }]}
        notice={notice ?? fileError}
        sub={notice ? undefined : 'reading settings…'} />
    );
  }

  if (view.at === 'local') {
    const rows = localRows(plain, view.showAllKeys, groups);
    const hidden = hiddenKeyCount(plain);
    return (
      <Screen title={title ?? 'local'}
        footer={[
          { key: 'enter', does: 'change' }, { key: 'd', does: 'reset' },
          { key: 'a', does: 'all keys', when: !!hidden }, { key: 'esc', does: 'close' },
        ]}
        notice={notice ?? fileError}
        sub={hidden && !view.showAllKeys ? `${hidden} other provider key${hidden > 1 ? 's' : ''} stored` : undefined}>
        <SelectList
          key={`local-${view.showAllKeys ? 'all' : 'some'}`}
          initial={last}
          choices={rows.map((r) => r.heading
            ? { value: r.key, label: r.label, heading: true }
            : {
              value: r.key,
              label: r.label,
              columns: [
                { text: r.shown, width: 24 },
                { text: `${config[r.key as ConfigKey].source}${config[r.key as ConfigKey].envVar ? ` (${config[r.key as ConfigKey].envVar})` : ''}` },
              ],
              hint: DESCRIPTIONS[r.key as ConfigKey],
            })}
          onSelect={(k) => {
            const key = k as ConfigKey;
            setLast(key);
            onOpenRow?.(key);
            void finishSpec(key, localSpec(key, plain, config[key].envVar, suggestions?.[key]), plain)
              .then((spec) => setView({ at: 'edit', scope: 'local', key, spec }));
          }}
          onCancel={onClose}
          onKey={(ch: string, cursorValue?: string) => {
            if (ch === 'a') {
              setLast(cursorValue);
              setView({ at: 'local', showAllKeys: !view.showAllKeys });
              return;
            }
            if (ch !== 'd') return;
            const key = cursorValue as ConfigKey;
            if (key && (Object.keys(DEFAULTS) as string[]).includes(key)) writeLocal(key, null);
          }}
        />
      </Screen>
    );
  }

  if (view.at === 'api') {
    // Nothing is on two screens. GET /settings carries everything, but the
    // credentials (secret, /keys masks them) and the keys /model and /voice
    // render (REMOTE_DEFAULTS — the same declaration that puts them there)
    // are never rows here.
    const entries = Object.entries(server ?? {})
      .filter(([k, s]) => !s.secret && !(k in REMOTE_DEFAULTS));
    return (
      <Screen title={title ?? 'settings'}
        footer={[
          { key: 'enter', does: 'change' }, { key: 'd', does: 'undo your change' },
          { key: 'esc', does: 'close' },
        ]}
        notice={notice}
        sub="applies to everyone · ↯ rows can also be set per workspace: /workspace, then e">
        {busy && !entries.length ? <Text dimColor>{'  loading…'}</Text> : (
          <SelectList
            key="api"
            initial={last}
            // ↯ marks the ones a single workspace can differ on. Without it the
            // only reachable way to change them is server-wide, which is how
            // you turn something on for everyone meaning to turn it on for one.
            choices={serverRows(entries).map((r) => r.heading
              ? { value: `#${r.key}`, label: r.key, heading: true }
              : {
                value: r.key, label: `${r.s!.overridable ? '↯ ' : '  '}${labelFor(r.key, r.s!.meta)}`,
                columns: [
                  { text: human(r.s!.value, r.s!.meta), width: 24 },
                  { text: r.s!.source === 'override' ? 'custom' : 'default' },
                ],
                // The description alone. The pretty label and the ↯ rule used to
                // stack under it as extra paragraphs; the sub says the rule once.
                hint: r.s!.description,
              })}
            onSelect={(k) => {
              const s = (server ?? {})[k as string];
              setLast(k as string);
              const values = Object.fromEntries(Object.entries(server ?? {}).map(([kk, v]) => [kk, v.value]));
              void finishSpec(k as string, {
                title: `${labelFor(k as string, s.meta)} · every workspace`,
                choices: s.meta?.choices,
                choiceLabels: s.meta?.choiceLabels,
                type: (s.meta?.type as EditSpec['type']) ?? 'string',
                current: s.value,
                note: s.meta?.unit === 'ms'
                  ? 'in milliseconds · applies to every workspace'
                  : 'applies to every workspace',
              }, values).then((spec) => setView({ at: 'edit', scope: 'api', key: k as string, spec }));
            }}
            onCancel={onClose}
            onKey={async (ch: string, cursorValue?: string) => {
              if (ch !== 'd' || !cursorValue) return;
              setBusy(true);
              try { await settings.clear(cursorValue); await loadServer(); }
              catch (e) { setNotice((e as Error).message); }
              finally { setBusy(false); }
            }}
          />
        )}
      </Screen>
    );
  }

  // view.at === 'edit'
  // Suggestions are read live: a device list that arrives while the picker is
  // open (the re-scan onOpenRow asked for) replaces the one captured on open.
  const fresh = view.scope === 'local' ? suggestions?.[view.key as ConfigKey] : undefined;
  const spec = fresh?.length ? { ...view.spec, suggestions: fresh } : view.spec;
  return (
    <ValueInput
      spec={spec}
      onCancel={() => setView(view.scope === 'local' ? { at: 'local' } : { at: 'api' })}
      onSubmit={async (v) => {
        if (view.scope === 'local') {
          writeLocal(view.key as ConfigKey, v);
          setView({ at: 'local' });
          return;
        }
        setBusy(true);
        try {
          await settings.patch({ [view.key]: v });
          await loadServer();
          setNotice(undefined);
        } catch (e) { setNotice((e as Error).message); }
        finally { setBusy(false); setView({ at: 'api' }); }
      }}
    />
  );
}

interface Row { key: string; label: string; shown: string; heading?: boolean }

/** Rows for the server screen: the entries gathered under their wire `group`
 *  headings, groups in order of first appearance. Entries without one (an
 *  older server) gather unheaded where the first of them appeared. */
export function serverRows(entries: Array<[string, ServerSetting]>):
  Array<{ key: string; s?: ServerSetting; heading?: boolean }> {
  const groups = new Map<string, Array<[string, ServerSetting]>>();
  for (const [k, s] of entries) {
    const g = s.meta?.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push([k, s]);
  }
  const out: Array<{ key: string; s?: ServerSetting; heading?: boolean }> = [];
  for (const [g, rows] of groups) {
    if (g) out.push({ key: g, heading: true });
    for (const [k, s] of rows) out.push({ key: k, s });
  }
  return out;
}

/** Rows for the local screen: grouped, with the inapplicable ones dropped. */
export function localRows(
  cfg: Record<ConfigKey, ConfigValue>, showAllKeys = false,
  only?: ReadonlyArray<Group>,
): Row[] {
  const visible = new Set(visibleKeys(cfg));
  if (showAllKeys) for (const k of Object.values(PROVIDER_KEY)) visible.add(k as unknown as ConfigKey);
  const out: Row[] = [];
  // With one group on screen the heading just repeats the title above it.
  const showHeadings = !only || only.length > 1;
  for (const [group, title] of GROUPS) {
    if (only && !only.includes(group)) continue;
    const keys = (Object.keys(DEFAULTS) as ConfigKey[])
      .filter((k) => META[k].group === group && visible.has(k));
    if (!keys.length) continue;
    if (showHeadings) out.push({ key: `#${group}`, label: title, shown: '', heading: true });
    for (const k of keys) {
      const v = cfg[k];
      out.push({
        key: k,
        label: localLabel(k),
        shown: META[k].secret ? mask(v) : v === null || v === '' ? '—' : String(v),
      });
    }
  }
  return out;
}

/** A local setting's name on screen: META.label when it has one, else the key
 *  in words. Voice rows drop their `voice_` prefix: under the "voice" heading
 *  or title, `voice spoken voice` says nothing that `spoken voice` does not. */
export const localLabel = (key: ConfigKey): string =>
  META[key].label ?? (META[key].group === 'voice' ? key.replace(/^voice_/, '') : key).replace(/_/g, ' ');

function localSpec(key: ConfigKey, cfg: Record<ConfigKey, ConfigValue>, envVar?: string, suggest?: string[]): EditSpec {
  const m = META[key];
  const spec: EditSpec = {
    title: localLabel(key),
    choices: m.choices,
    secret: m.secret,
    type: m.type,
    current: m.secret ? '' : cfg[key],
    note: envVar
      ? `${envVar} is set in your shell and beats this file — unset it for a saved value to take effect`
      : m.secret ? `saved to ${CONFIG_PATH}, mode 0600` : undefined,
  };
  // Device rows offer what the sidecar found; a name it did not list can still
  // be typed (a device plugged in later, or a sidecar that is not running yet).
  if (suggest?.length) {
    spec.suggestions = suggest;
    spec.note = spec.note ?? 'devices found now · or type any device name';
  }
  return spec;
}

/** One row of GET /models. */
interface CatalogModel { id: string; name: string }

const set = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Every model row and the provider row it follows — its own when overridden,
 *  else the coding agent's it cascades to. The same picker on every screen:
 *  the four are the same kind of row. */
const MODEL_ROWS: Record<string, string> = {
  model: 'provider', assistant_model: 'assistant_provider',
  supervisor_model: 'supervisor_provider', git_fixer_model: 'git_fixer_provider',
};

const PROVIDER_ROWS = new Set(Object.values(MODEL_ROWS));

/** The provider a model row's catalog is for; null when it is not a model row
 *  or no provider is set yet. */
export function providerForModelRow(key: string, values: Record<string, unknown>): string | null {
  const p = MODEL_ROWS[key];
  return p ? set(values[p]) ?? set(values.provider) : null;
}

/** A provider row lists only the providers with a key on /keys — a provider
 *  you cannot call is not a choice. With no key stored yet, every provider
 *  and a note saying where the key goes. null for any other row. */
export function providerChoices(key: string, choices: readonly string[] | undefined,
  values: Record<string, unknown>): Pick<EditSpec, 'choices' | 'note'> | null {
  if (!PROVIDER_ROWS.has(key)) return null;
  const all = choices ?? PROVIDERS;
  const keyed = all.filter((p) => set(values[PROVIDER_KEY[p as keyof typeof PROVIDER_KEY]]));
  return keyed.length
    ? { choices: keyed, note: 'providers with a key on /keys' }
    : { choices: all, note: 'no provider key on /keys yet — save one there first' };
}
