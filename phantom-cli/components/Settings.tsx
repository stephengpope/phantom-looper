// ONE settings screen: every server setting, grouped the way the server
// files them — the three agents first (coding, assistant, supervisor; each
// with model and compaction sub-headings, the assistant its voice too), then
// the areas (board, crons, sessions, containers, git, limits, telegram). This
// machine's own audio rows (mic, speaker, mutes) sit under the assistant as
// "this machine". /assistant opens the same screen at that group.
//
// /server is the one other use of this component: this machine's connection
// rows alone, with no network call — you edit the connection precisely when
// the server is unreachable.
//
// Two more scopes exist and are deliberately NOT here: one project's own
// values (ProjectSettings.tsx, `e` on a row in /project) and the server's
// credentials (Keys.tsx, /keys). This screen marks the settings a project
// can differ on with ↯ so the server-wide list points at them, but it never
// edits them — changing something for everyone and changing it for one
// project must not be two rows apart in the same list.
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
import { PROVIDERS, keyedProviders } from '@phantom-agent-sdk/client';

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
const usesBaseUrl = (provider: unknown) => provider === 'openai' || provider === 'deepseek' || provider === 'kimi' || provider === 'openai-compatible';
const set = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
export const HIDDEN: Record<string, (values: Record<string, unknown>) => boolean> = {
  coding_base_url: (values) => !usesBaseUrl(values.coding_provider),
  assistant_base_url: (values) => !usesBaseUrl(set(values.assistant_provider) ?? values.coding_provider),
  supervisor_base_url: (values) => !usesBaseUrl(set(values.supervisor_provider) ?? values.coding_provider),
  voice_wake_words: (values) => values.voice_wake_word !== true,
  voice_wake_timeout: (values) => values.voice_wake_word !== true,
  // The API docs are the service role's switch (PATCH /api/settings), not this app's.
  api_docs_enabled: () => true,
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
  /** The group to open on — /assistant lands on `assistant`. */
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
    catch (entry) { setNotice(`server unreachable: ${(entry as Error).message}`); setServer({}); }
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
      const reply = await api('GET', `/app/models?provider=${encodeURIComponent(provider)}`) as { models?: CatalogModel[] };
      return Array.isArray(reply?.models) ? reply.models : [];
    } catch (entry) {
      // The row stays free-text, and the notice says why the list is missing
      // — an empty picker must not read as "this provider has no models".
      setNotice(`could not load the model list: ${(entry as Error).message}`);
      return [];
    }
  }, [api]);

  const serverValues = (): Record<string, unknown> =>
    Object.fromEntries(Object.entries(server ?? {}).map(([key, entry]) => [key, entry.value]));

  const openServer = async (key: string) => {
    const entry = server![key];
    setLast(key);
    const values = serverValues();
    const spec: EditSpec = {
      title: `${labelFor(key, entry.meta)} · everyone`,
      choices: entry.meta.choices, choiceLabels: entry.meta.choiceLabels, suggestions: entry.meta.suggestions,
      type: entry.meta.type, current: entry.value, unit: entry.meta.unit,
      note: entry.meta.unit === 'ms' ? 'e.g. 30m, 2h, 3d · applies to everyone' : 'applies to everyone',
    };
    const provider = providerForModelRow(key, values);
    const models = provider ? await loadModels(provider) : [];
    setView({ at: 'edit', kind: 'server', key, spec: buildModelSpec(key, spec, values, models, server ?? {}) });
  };

  const openLocal = (key: LocalKey) => {
    setLast(key);
    onOpenRow?.(key);
    const meta = META[key];
    const spec: EditSpec = {
      title: meta.label, secret: meta.secret, type: meta.type,
      current: meta.secret ? '' : local[key].value,
      note: local[key].envVar
        ? `${local[key].envVar} is set in your shell and beats this file — unset it for a saved value to take effect`
        : meta.secret ? `saved to ${configPath}, mode 0600` : undefined,
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
    try { await settings.patch(patch); await loadServer(); for (const key of Object.keys(patch)) onChange?.(key); }
    catch (entry) { setNotice((entry as Error).message); }
    finally { setBusy(false); }
  };
  const writeLocal = async (key: LocalKey, value: ConfigValue) => {
    try { await settings.write(key, value); setNotice(undefined); setTick((tick) => tick + 1); onChange?.(key); }
    catch (entry) { setNotice(`could not save: ${(entry as Error).message}`); }
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
        onSubmit={(value) => {
          setView({ at: 'list' });
          if (view.kind === 'local') { void writeLocal(view.key as LocalKey, value as ConfigValue); return; }
          // A provider change invalidates its model — the old id belongs to
          // the old provider's catalog. Clear it in the same write so the row
          // shows "—" (= newest for the new provider) rather than a stale id.
          const modelKey = MODEL_FOR_PROVIDER[view.key];
          const patch: Record<string, ConfigValue> = { [view.key]: value as ConfigValue };
          if (modelKey && value !== view.spec.current) patch[modelKey] = null;
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
  const choices = headedChoices(blocks, (row): Choice<string> =>
    ({ value: row.key, label: row.label, columns: [{ text: row.shown, width: 24 }, { text: row.source }], hint: row.hint }));
  const first = startAt ? blocks.find((b) => b.group === startAt)?.items[0]?.key : undefined;
  return (
    <Screen title={title}
      footer={[
        { key: 'enter', does: 'change' }, { key: 'd', does: 'reset' }, { key: 'esc', does: 'close' },
      ]}
      notice={notice ?? fileError}
      sub={rows.server ? 'applies to everyone · "this machine" rows stay here · ↯ rows can also be set per project: /project, then e' : undefined}>
      {busy && !choices.length ? <Text dimColor>{'  loading…'}</Text> : (
        <SelectList
          key={`rows-${rows.local ?? ''}`}
          initial={last ?? first}
          choices={choices}
          onSelect={(key) => {
            if (server?.[key] && !isLocal(key)) void openServer(key);
            else if (isLocal(key)) openLocal(key);
          }}
          onCancel={onClose}
          onKey={(char: string, cursorValue?: string) => {
            if (char !== 'd' || !cursorValue) return;
            if (isLocal(cursorValue)) { void writeLocal(cursorValue, null); return; }
            if (server?.[cursorValue]) void writeServer({ [cursorValue]: null });
          }}
        />
      )}
    </Screen>
  );
}

const isLocal = (key: string): key is LocalKey => (LOCAL_KEYS as readonly string[]).includes(key);

/** One list row and where it files. A server row files where its wire meta
 *  says; a local row under "this machine" inside the group it belongs to. */
interface Row { key: string; label: string; shown: string; source: string; hint?: string; group: string; subgroup: string }

/** This machine's voice rows file under the assistant, as its last sub-heading. */
const LOCAL_HOME: Record<'voice' | 'server', string> = { voice: 'assistant', server: '' };

/** The rows a screen shows, in the server's order and grouping (hidden-when
 *  rules applied), with this machine's rows folded in. */
export function screenRows(rows: Rows, server: Record<string, Entry>, local: ReturnType<typeof resolveLocal>['config']): Block<Row>[] {
  const values = Object.fromEntries(Object.entries(server).map(([key, entry]) => [key, entry.value]));
  const out: Row[] = [];
  if (rows.server) {
    for (const [key, entry] of Object.entries(server)) {
      if (entry.secret || isLocal(key)) continue;                   // credentials are /keys; a local key never comes from the server
      if (HIDDEN[key]?.(values)) continue;
      out.push({ key, group: entry.meta?.group ?? '', subgroup: entry.meta?.subgroup ?? '',
        label: `${entry.overridable ? '↯ ' : ''}${labelFor(key, entry.meta)}`,
        shown: human(entry.value, entry.meta), source: entry.source, hint: entry.description });
    }
  }
  if (rows.local) {
    for (const key of LOCAL_KEYS.filter((key) => META[key].group === rows.local)) {
      const resolved = local[key];
      out.push({ key, group: LOCAL_HOME[rows.local], subgroup: 'this machine', label: META[key].label,
        shown: META[key].secret ? mask(resolved.value) : human(resolved.value),
        source: `${resolved.source}${resolved.envVar ? ` (${resolved.envVar})` : ''}`, hint: DESCRIPTIONS[key] });
    }
  }
  return groupBlocks(out, (row) => row);
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
  Object.entries(MODEL_ROWS).map(([model, provider]) => [provider, model]));

/** The provider a model row's catalog is for; null when it is not a model row
 *  or no provider is set yet. */
export function providerForModelRow(key: string, values: Record<string, unknown>): string | null {
  const provider = MODEL_ROWS[key];
  return provider ? set(values[provider]) ?? set(values.coding_provider) : null;
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
  // THE rule (@phantom-agent-sdk/client keyedProviders): a key from any layer counts — the
  // project read carries a credential's source only, never its value.
  const keyed = keyedProviders(entries).filter((provider) => all.includes(provider));
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
    suggestions: models.map((model) => model.id),
    suggestionLabels: Object.fromEntries(models.map((model) => [model.id, model.name])),
    note: spec.note ?? `${provider} models, newest first · or type any model id · empty = the newest` };
}
