// ONE settings screen: every server setting, grouped the way the server
// files them — the three agents first (coding, assistant, supervisor; each
// with model and compaction sub-headings, the assistant its voice too), then
// the areas (board, crons, sessions, containers, git, limits, telegram). This
// machine's own audio rows (mic, speaker, mutes) sit under the assistant as
// "this machine". /model and /assistant open the same screen at that group.
//
// /server is the one other use of this component: this machine's connection
// rows alone, with no network call — you edit the connection precisely when
// the server is unreachable.
//
// Two more scopes exist and are deliberately NOT here: one workspace's own
// values (WorkspaceSettings.tsx, `e` on a row in /workspace) and the server's
// credentials (Keys.tsx, /keys). This screen marks the settings a workspace
// can differ on with ↯ so the server-wide list points at them, but it never
// edits them — changing something for everyone and changing it for one
// workspace must not be two rows apart in the same list.
//
// A server row is rendered from what GET /settings sends — label, description,
// type, choices, unit, which layer the value came from. Nothing about a server
// key is declared in this package: the server is the one place a setting is
// described, and this screen shows it verbatim. Only the local rows
// (config.ts) are declared here, because they are this machine's.
import { Text } from './Text.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DESCRIPTIONS, META, CONFIG_PATH, LOCAL_KEYS,
  mask, type LocalKey, type ConfigValue,
} from '../config.js';
import { resolveLocal } from '../local.js';
import { makeSettings, type Entry } from '../settings.js';
import { SelectList, type Choice } from './SelectList.js';
import { human, labelFor } from '../settingLabels.js';
import { groupBlocks, headedChoices, type Block } from '../settingGroups.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import { PROVIDERS } from '../../core/llm/createAgent.js';

export type { Api } from '../request.js';
import type { Api } from '../request.js';

/** Which rows a screen shows: the server's settings, and/or one of this
 *  machine's two local groups (the voice rows file under the assistant). */
export interface Rows {
  server?: boolean;
  local?: 'server' | 'voice';
}

type View =
  | { at: 'list' }
  | { at: 'edit'; kind: 'server' | 'local'; key: string; spec: EditSpec };

/** Rows that cannot apply right now, hidden rather than shown dead: an
 *  endpoint for a provider that has none, wake words while wake is off.
 *  Presentation only — the server still stores and returns them. */
const usesBaseUrl = (p: unknown) => p === 'openai' || p === 'deepseek' || p === 'kimi' || p === 'openai-compatible';
const set = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const HIDDEN: Record<string, (values: Record<string, unknown>) => boolean> = {
  coding_base_url: (v) => !usesBaseUrl(v.coding_provider),
  assistant_base_url: (v) => !usesBaseUrl(set(v.assistant_provider) ?? v.coding_provider),
  supervisor_base_url: (v) => !usesBaseUrl(set(v.supervisor_provider) ?? v.coding_provider),
  voice_wake_words: (v) => v.voice_wake_word !== true,
  voice_wake_timeout: (v) => v.voice_wake_word !== true,
};

export function Settings({ api, onClose, onChange, configPath = CONFIG_PATH, rows, title, startAt, suggestions, onOpenRow }: {
  api: Api;
  onClose: () => void;
  /** Fired after any write, naming the key, so the app re-reads what it
   *  consumes — rebuilds an agent, restarts the sidecar, reloads a board. */
  onChange?: (key: string) => void;
  configPath?: string;
  rows: Rows;
  title: string;
  /** The group to open on — /model lands on `coding`, /assistant on `assistant`. */
  startAt?: string;
  /** Values to offer for a local key that has no fixed choices — the device
   *  names the voice sidecar reported, for the mic and speaker rows. Read
   *  live, so a list that arrives while the picker is open shows up in it. */
  suggestions?: Partial<Record<LocalKey, string[]>>;
  /** Fired when a local row's editor opens — the voice rows use it to re-scan
   *  devices at the one moment a fresh list matters. */
  onOpenRow?: (key: LocalKey) => void;
}) {
  const [view, setView] = useState<View>({ at: 'list' });
  const [tick, setTick] = useState(0);              // forces a re-read after a local write
  const [server, setServer] = useState<Record<string, Entry> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  // The row the list left from — the editor replaces the list, and when the
  // list comes back its cursor returns HERE, not to the top. Before any row
  // was opened: the first row of the group the command asked for.
  const [last, setLast] = useState<string | undefined>();

  // Opening the screen is a READ, and so is every write's aftermath. The screen
  // shows what is stored right now — never a copy the app has been carrying
  // since launch, which is what left the Assistant running on the settings it
  // was born with.
  const settings = useMemo(() => makeSettings(api, configPath), [api, configPath]);
  const loadServer = useCallback(async () => {
    setBusy(true);
    try { setServer(await settings.all()); setNotice(undefined); }
    catch (e) { setNotice(`server unreachable: ${(e as Error).message}`); setServer({}); }
    finally { setBusy(false); }
  }, [settings]);
  useEffect(() => { if (rows.server) void loadServer(); }, [rows.server, loadServer]);

  // This machine's rows, read from the file on every render (a file read is
  // cheap and synchronous); `tick` re-renders after a write.
  const { config: local, error: fileError } = resolveLocal(configPath);
  void tick;

  // The model catalog is the SERVER's (GET /models): one list for every
  // client and for the "newest model" default. Read when a model row's editor
  // opens; a server that cannot answer leaves the row free-text.
  const loadModels = useCallback(async (provider: string): Promise<CatalogModel[]> => {
    try {
      const r = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models?: CatalogModel[] };
      return Array.isArray(r?.models) ? r.models : [];
    } catch (e) {
      // The row stays free-text, and the notice says why the list is missing
      // — an empty picker must not read as "this provider has no models".
      setNotice(`could not load the model list: ${(e as Error).message}`);
      return [];
    }
  }, [api]);

  const serverValues = (): Record<string, unknown> =>
    Object.fromEntries(Object.entries(server ?? {}).map(([k, e]) => [k, e.value]));

  const openServer = async (key: string) => {
    const e = server![key];
    setLast(key);
    const values = serverValues();
    const spec: EditSpec = {
      title: `${labelFor(key, e.meta)} · everyone`,
      choices: e.meta.choices, choiceLabels: e.meta.choiceLabels, suggestions: e.meta.suggestions,
      type: e.meta.type, current: e.value, unit: e.meta.unit,
      note: e.meta.unit === 'ms' ? 'e.g. 30m, 2h, 3d · applies to everyone' : 'applies to everyone',
    };
    const provider = providerForModelRow(key, values);
    const models = provider ? await loadModels(provider) : [];
    setView({ at: 'edit', kind: 'server', key, spec: buildModelSpec(key, spec, values, models, server ?? {}) });
  };

  const openLocal = (key: LocalKey) => {
    setLast(key);
    onOpenRow?.(key);
    const m = META[key];
    const spec: EditSpec = {
      title: m.label, secret: m.secret, type: m.type,
      current: m.secret ? '' : local[key].value,
      note: local[key].envVar
        ? `${local[key].envVar} is set in your shell and beats this file — unset it for a saved value to take effect`
        : m.secret ? `saved to ${configPath}, mode 0600` : undefined,
    };
    // Device rows offer what the sidecar found; a name it did not list can
    // still be typed (a device plugged in later, or a sidecar not running yet).
    const suggest = suggestions?.[key];
    if (suggest?.length) { spec.suggestions = suggest; spec.note = spec.note ?? 'devices found now · or type any device name'; }
    setView({ at: 'edit', kind: 'local', key, spec });
  };

  // ONE writer per home. After a write this screen re-reads and shows what was
  // stored, never what was sent.
  const writeServer = async (patch: Record<string, ConfigValue>) => {
    setBusy(true);
    try { await settings.patch(patch); await loadServer(); for (const k of Object.keys(patch)) onChange?.(k); }
    catch (e) { setNotice((e as Error).message); }
    finally { setBusy(false); }
  };
  const writeLocal = async (key: LocalKey, v: ConfigValue) => {
    try { await settings.write(key, v); setNotice(undefined); setTick((t) => t + 1); onChange?.(key); }
    catch (e) { setNotice(`could not save: ${(e as Error).message}`); }
  };

  if (view.at === 'edit') {
    // Suggestions are read live: a device list that arrives while the picker
    // is open (the re-scan onOpenRow asked for) replaces the one captured.
    const fresh = view.kind === 'local' ? suggestions?.[view.key as LocalKey] : undefined;
    const spec = fresh?.length ? { ...view.spec, suggestions: fresh } : view.spec;
    return (
      <ValueInput
        spec={spec}
        onCancel={() => setView({ at: 'list' })}
        onSubmit={(v) => {
          setView({ at: 'list' });
          if (view.kind === 'local') { void writeLocal(view.key as LocalKey, v as ConfigValue); return; }
          // A provider change invalidates its model — the old id belongs to
          // the old provider's catalog. Clear it in the same write so the row
          // shows "—" (= newest for the new provider) rather than a stale id.
          const modelKey = MODEL_FOR_PROVIDER[view.key];
          const patch: Record<string, ConfigValue> = { [view.key]: v as ConfigValue };
          if (modelKey && v !== view.spec.current) patch[modelKey] = null;
          void writeServer(patch);
        }}
      />
    );
  }

  // Until the read lands there is nothing true to show. Rendering the rows
  // early painted them from defaults with no source beside them — which is the
  // same lie as a cache, just a shorter one.
  if (rows.server && server === null) {
    return <Screen title={title} footer={[{ key: 'esc', does: 'close' }]}
      notice={notice ?? fileError} sub={notice ? undefined : 'reading settings…'} />;
  }

  const blocks = screenRows(rows, server ?? {}, local);
  const choices = headedChoices(blocks, (r): Choice<string> =>
    ({ value: r.key, label: r.label, columns: [{ text: r.shown, width: 24 }, { text: r.source }], hint: r.hint }));
  const first = startAt ? blocks.find((b) => b.group === startAt)?.items[0]?.key : undefined;
  return (
    <Screen title={title}
      footer={[
        { key: 'enter', does: 'change' }, { key: 'd', does: 'reset' }, { key: 'esc', does: 'close' },
      ]}
      notice={notice ?? fileError}
      sub={rows.server ? 'applies to everyone · "this machine" rows stay here · ↯ rows can also be set per workspace: /workspace, then e' : undefined}>
      {busy && !choices.length ? <Text dimColor>{'  loading…'}</Text> : (
        <SelectList
          key={`rows-${rows.local ?? ''}`}
          initial={last ?? first}
          choices={choices}
          onSelect={(k) => {
            if (server?.[k] && !isLocal(k)) void openServer(k);
            else if (isLocal(k)) openLocal(k);
          }}
          onCancel={onClose}
          onKey={(ch: string, cursorValue?: string) => {
            if (ch !== 'd' || !cursorValue) return;
            if (isLocal(cursorValue)) { void writeLocal(cursorValue, null); return; }
            if (server?.[cursorValue]) void writeServer({ [cursorValue]: null });
          }}
        />
      )}
    </Screen>
  );
}

const isLocal = (k: string): k is LocalKey => (LOCAL_KEYS as readonly string[]).includes(k);

/** One list row and where it files. A server row files where its wire meta
 *  says; a local row under "this machine" inside the group it belongs to. */
interface Row { key: string; label: string; shown: string; source: string; hint?: string; group: string; subgroup: string }

/** This machine's voice rows file under the assistant, as its last sub-heading. */
const LOCAL_HOME: Record<'voice' | 'server', string> = { voice: 'assistant', server: '' };

/** The rows a screen shows, in the server's order and grouping (hidden-when
 *  rules applied), with this machine's rows folded in. */
export function screenRows(rows: Rows, server: Record<string, Entry>, local: ReturnType<typeof resolveLocal>['config']): Block<Row>[] {
  const values = Object.fromEntries(Object.entries(server).map(([k, e]) => [k, e.value]));
  const out: Row[] = [];
  if (rows.server) {
    for (const [k, e] of Object.entries(server)) {
      if (e.secret || isLocal(k)) continue;                   // credentials are /keys; a local key never comes from the server
      if (HIDDEN[k]?.(values)) continue;
      out.push({ key: k, group: e.meta?.group ?? '', subgroup: e.meta?.subgroup ?? '',
        label: `${e.overridable ? '↯ ' : ''}${labelFor(k, e.meta)}`,
        shown: human(e.value, e.meta), source: e.source, hint: e.description });
    }
  }
  if (rows.local) {
    for (const k of LOCAL_KEYS.filter((k) => META[k].group === rows.local)) {
      const r = local[k];
      out.push({ key: k, group: LOCAL_HOME[rows.local], subgroup: 'this machine', label: META[k].label,
        shown: META[k].secret ? mask(r.value) : human(r.value),
        source: `${r.source}${r.envVar ? ` (${r.envVar})` : ''}`, hint: DESCRIPTIONS[k] });
    }
  }
  return groupBlocks(out, (r) => r);
}

/** One row of GET /models. */
export interface CatalogModel { id: string; name: string }

/** Every model row and the provider row it follows — its own when overridden,
 *  else the coding agent's it cascades to. The same picker on every screen:
 *  the three are the same kind of row. */
export const MODEL_ROWS: Record<string, string> = {
  coding_model: 'coding_provider', assistant_model: 'assistant_provider',
  supervisor_model: 'supervisor_provider',
};

export const PROVIDER_ROWS = new Set(Object.values(MODEL_ROWS));

/** The model key to clear when a provider key changes. */
export const MODEL_FOR_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_ROWS).map(([m, p]) => [p, m]));

/** The provider a model row's catalog is for; null when it is not a model row
 *  or no provider is set yet. */
export function providerForModelRow(key: string, values: Record<string, unknown>): string | null {
  const p = MODEL_ROWS[key];
  return p ? set(values[p]) ?? set(values.coding_provider) : null;
}

/** A provider row lists only the providers with a key on /keys — a provider
 *  you cannot call is not a choice (one that takes no key, openai-codex, is
 *  always a choice). Which row holds which provider's key is the SERVER's
 *  declaration, read off each credential entry's `meta.provider` — nothing
 *  here maps providers to keys. With no key stored yet, every provider and a
 *  note saying where the key goes. null for any other row. */
export function providerChoices(key: string, choices: readonly string[] | undefined,
  entries: Record<string, Entry>): Pick<EditSpec, 'choices' | 'note'> | null {
  if (!PROVIDER_ROWS.has(key)) return null;
  const all = choices ?? PROVIDERS;
  const keyEntry = (p: string) => Object.values(entries).find((e) => e.meta.provider === p);
  const keyed = all.filter((p) => { const e = keyEntry(p); return !e || set(e.value); });
  return keyed.length
    ? { choices: keyed, note: 'providers with a key on /keys' }
    : { choices: all, note: 'no provider key on /keys yet — save one there first' };
}

/** Enriches an EditSpec for a provider or model row with the keyed-provider
 *  filter or the model catalog. Pure: the caller supplies the catalog.
 *  `values` decides which provider a model row follows (a preset's values may
 *  overlay the server's); `entries` is the server's own read, for the keys.
 *  Used by Settings and by Presets. */
export function buildModelSpec(
  key: string, spec: EditSpec, values: Record<string, unknown>,
  models: CatalogModel[], entries: Record<string, Entry>,
): EditSpec {
  const providerRow = providerChoices(key, spec.choices, entries);
  if (providerRow) return { ...spec, ...providerRow };
  const provider = providerForModelRow(key, values);
  if (!provider) return spec;
  if (!models.length) return spec;
  return { ...spec,
    suggestions: models.map((m) => m.id),
    suggestionLabels: Object.fromEntries(models.map((m) => [m.id, m.name])),
    note: spec.note ?? `${provider} models, newest first · or type any model id · empty = the newest` };
}
