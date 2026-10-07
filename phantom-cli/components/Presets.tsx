// Provider presets — saved configurations of all model settings that can be
// applied with one action.
//
// Three views:
//   list    the saved presets, with [enter] apply, [e] edit, [n] new, [d] delete
//   name    naming a new preset (TextInput on a Screen)
//   editor  the 15 model keys for one preset (SelectList + ValueInput, same
//           pattern as /settings)
//
// Each key in a preset has three states:
//   set             a value — apply writes it
//   clear           null  — apply nulls the setting (cascade/default takes over)
//   leave unchanged absent  — apply does not touch the setting
//
// Storage: the preset's `values` object is { key: value } for set keys,
// { key: null } for clear, and the key is absent for leave-unchanged. On
// apply the object is sent as the PATCH body — set keys write, null keys
// clear, absent keys are untouched. Clear is the default: a new preset
// starts with every key null, and leave-unchanged is the deliberate opt-out.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box } from 'ink';
import { useInput } from './useInput.js';
import { FixedText, Text } from './Text.js';
import { SelectList, type Choice } from './SelectList.js';
import { tableChoices, type TableRow } from './table.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import { TextInput } from './TextInput.js';
import { makeSettings, type Entry } from '../settings.js';
import { groupBlocks, headedChoices, type Block } from '../settingGroups.js';
import { type ConfigValue } from '../config.js';
import {
  buildModelSpec, providerForModelRow, MODEL_FOR_PROVIDER,
  type CatalogModel,
} from './Settings.js';
import type { Api } from '../request.js';
import { newId } from '@phantom-agent-sdk/client';

/** The model keys a preset may hold, grouped per agent — read off GET
 *  /settings: every entry whose `meta.subgroup` is `model`, under its
 *  `meta.group`, with the server's label and choices. The server's presets.ts
 *  derives its allowed list from the same fact; nothing is listed here. */
interface PresetKey { key: string; label: string; choices?: readonly string[]; group: string }
type PresetGroup = Block<PresetKey>;
export function presetGroups(entries: Record<string, Entry>): PresetGroup[] {
  const keys = Object.entries(entries)
    .filter(([, entry]) => entry.meta.subgroup === 'model' && entry.meta.group)
    .map(([key, entry]): PresetKey => ({ key, label: entry.meta.label ?? key, choices: entry.meta.choices, group: entry.meta.group! }));
  return groupBlocks(keys, (key) => key);
}
const allKeys = (groups: PresetGroup[]) => groups.flatMap((group) => group.items.map((key) => key.key));

export interface Preset { id: string; name: string; values: Record<string, unknown> }

/** The three states a key can be in inside a preset. */
type KeyState = 'set' | 'clear' | 'leave';

function keyState(values: Record<string, unknown>, key: string): KeyState {
  if (!(key in values)) return 'leave';
  return values[key] === null ? 'clear' : 'set';
}

type View =
  | { at: 'list' }
  | { at: 'name' }
  | { at: 'rename'; preset: Preset }
  | { at: 'editor'; preset: Preset }
  | { at: 'editValue'; preset: Preset; key: string; spec: EditSpec };

/** A summary cell: the value, or the system's empty-cell glyph (as /resume
 *  draws a missing model) — never a dot used as a SEPARATOR between facts. */
const cell = (value: unknown): string => (typeof value === 'string' ? value : '·');

/** The selection list's rows, through the shared table system: provider,
 *  model and reasoning each in their own aligned column under a header —
 *  the same shape /resume, /tasks and /archived draw. Replaces the old
 *  `detail` string that joined the three with ' · ' into one ragged blob. */
export function presetChoices(presets: Preset[], groups: PresetGroup[]): Choice<string | null>[] {
  const rows = presets.map((preset): TableRow<string> => ({
    value: preset.id,
    cells: [preset.name, cell(preset.values.coding_provider), cell(preset.values.coding_model), cell(preset.values.coding_reasoning)],
    hint: presetHint(preset, groups),
  }));
  return tableChoices('preset', [
    { title: 'provider', cap: 18 },   // fits 'openai-compatible' (17)
    { title: 'model', cap: 30 },      // long ids truncate, never wrap
    { title: 'reasoning' },           // the last column runs free
  ], rows);
}

/** The value column on the preset editor row. */
function displayValue(state: KeyState, value: unknown): string {
  if (state === 'leave') return '· leave unchanged';
  if (state === 'clear') return '∅ clear';
  return String(value);
}

/** The full hint for the list's hint block: all 15 keys laid out. */
function presetHint(preset: Preset, groups: PresetGroup[]): string {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group.group}:`);
    for (const key of group.items) {
      const state = keyState(preset.values, key.key);
      const label = state === 'set' ? String(preset.values[key.key])
        : state === 'clear' ? 'clear' : 'leave unchanged';
      lines.push(`  ${key.label}: ${label}`);
    }
  }
  return lines.join('\n');
}

function hintForKey(state: KeyState, value: unknown): string {
  if (state === 'set') return `apply writes this value: ${String(value)}`;
  if (state === 'clear') return 'clear — apply wipes this setting; the normal fallback takes over';
  return 'leave unchanged — apply won\'t touch this setting';
}

export function Presets({ api, confirm, onApplied, onClose }: {
  api: Api;
  /** THE yes/no (the window's dialog) — [enter] asks through it before applying. */
  confirm: (title: string, message?: string) => Promise<boolean>;
  /** Fired after a preset is applied so the app can rebuild agents and
   *  confirm the switch — the screen closes on apply, so the confirmation
   *  has to live where the user lands: the CLI. */
  onApplied: (name: string) => void;
  onClose: () => void;
}) {
  const settings = useMemo(() => makeSettings(api), [api]);
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [view, setView] = useState<View>({ at: 'list' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [last, setLast] = useState<string | undefined>();
  const [nameText, setNameText] = useState('');

  // The server's settings, entries and all: the values a preset overlays, and
  // the credential rows that say which providers have a key.
  const [serverEntries, setServerEntries] = useState<Record<string, Entry> | null>(null);
  useEffect(() => {
    void settings.all()
      .then((reply) => setServerEntries(reply))
      .catch((error: unknown) => setNotice(`server unreachable: ${(error as Error).message}`));
  }, [settings]);
  const serverCfg = useMemo(() => serverEntries
    ? Object.fromEntries(Object.entries(serverEntries).map(([key, entry]) => [key, entry.value as ConfigValue])) : null, [serverEntries]);
  const groups = useMemo(() => presetGroups(serverEntries ?? {}), [serverEntries]);
  const keys = useMemo(() => allKeys(groups), [groups]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const reply = await api('GET', '/presets') as Preset[];
      setPresets(reply);
      setNotice(undefined);
    } catch (entry) { setNotice(`could not load presets: ${(entry as Error).message}`); setPresets([]); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // Model catalog loader — same pattern as Settings.tsx.
  const loadModels = useCallback(async (provider: string): Promise<CatalogModel[]> => {
    try {
      const reply = await api('GET', `/app/models?provider=${encodeURIComponent(provider)}`) as { models?: CatalogModel[] };
      return Array.isArray(reply?.models) ? reply.models : [];
    } catch (entry) {
      setNotice(`could not load the model list: ${(entry as Error).message}`);
      return [];
    }
  }, [api]);

  const finishSpec = async (key: string, spec: EditSpec, values: Record<string, unknown>): Promise<EditSpec> => {
    const provider = providerForModelRow(key, values);
    const models = provider ? await loadModels(provider) : [];
    return buildModelSpec(key, spec, values, models, serverEntries ?? {});
  };

  // ── Apply ──────────────────────────────────────────────────────────────────
  const applyPreset = useCallback(async (preset: Preset) => {
    setBusy(true);
    try {
      // Build a PATCH body from only the keys the preset has an opinion on.
      // set keys → their value, clear keys → null, leave-unchanged keys → skipped.
      const patch: Record<string, ConfigValue> = {};
      for (const key of keys) {
        if (!(key in preset.values)) continue;            // leave unchanged — don't touch
        patch[key] = preset.values[key] as ConfigValue;     // value or null
      }
      if (Object.keys(patch).length) {
        await settings.patch(patch);
      }
      // Apply is the destination, not a step: back to the CLI, where
      // onApplied confirms the switch. A failure keeps the screen open
      // with the error.
      onApplied(preset.name);
      onClose();
    } catch (entry) { setNotice(`could not apply: ${(entry as Error).message}`); }
    finally { setBusy(false); }
  }, [settings, keys, onApplied, onClose]);

  // ── Save one key in a preset ───────────────────────────────────────────────
  // value = a real value → set; null → clear; undefined → leave unchanged
  const savePresetKey = useCallback(async (preset: Preset, key: string, value: unknown) => {
    const next = { ...preset.values };
    if (value === undefined) {
      delete next[key];                  // leave unchanged
    } else {
      next[key] = value;                 // set (a value) or clear (null)
    }
    // When a provider changes, reset its model to clear (the default state)
    // — same UX as /settings clearing the model when the provider changes.
    const modelKey = MODEL_FOR_PROVIDER[key];
    if (modelKey && value !== preset.values[key]) next[modelKey] = null;
    setBusy(true);
    try {
      await api('PUT', `/presets/${preset.id}`, { name: preset.name, values: next });
      const updated = { ...preset, values: next };
      setPresets((presets) => (presets ?? []).map((preset) => preset.id === preset.id ? updated : preset));
      setView({ at: 'editor', preset: updated });
      setNotice(undefined);
    } catch (entry) { setNotice(`could not save: ${(entry as Error).message}`); }
    finally { setBusy(false); }
  }, [api]);

  // ── Create ─────────────────────────────────────────────────────────────────
  const createPreset = useCallback(async (name: string) => {
    setBusy(true);
    try {
      const id = newId();
      // Clear is the default: a new preset resets every key it doesn't set.
      const values = Object.fromEntries(keys.map((key) => [key, null]));
      await api('PUT', `/presets/${id}`, { name, values });
      const preset: Preset = { id, name, values };
      await load();
      setView({ at: 'editor', preset });
      setNotice(undefined);
    } catch (entry) { setNotice(`could not create: ${(entry as Error).message}`); }
    finally { setBusy(false); }
  }, [api, keys, load]);

  // ── Rename ─────────────────────────────────────────────────────────────────
  const renamePreset = useCallback(async (preset: Preset, name: string) => {
    setBusy(true);
    try {
      await api('PUT', `/presets/${preset.id}`, { name, values: preset.values });
      const updated = { ...preset, name };
      setPresets((presets) => (presets ?? []).map((preset) => preset.id === preset.id ? updated : preset));
      setView({ at: 'editor', preset: updated });
      setNotice(undefined);
    } catch (entry) { setNotice(`could not rename: ${(entry as Error).message}`); }
    finally { setBusy(false); }
  }, [api]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const deletePreset = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await api('DELETE', `/presets/${id}`);
      await load();
      setNotice('preset deleted');
    } catch (entry) { setNotice(`could not delete: ${(entry as Error).message}`); }
    finally { setBusy(false); }
  }, [api, keys, load]);

  // ── Name input for a new preset ────────────────────────────────────────────
  if (view.at === 'name') {
    return (
      <NameInput notice={notice} initial={nameText}
        onSubmit={(name) => { void createPreset(name); }}
        onCancel={() => setView({ at: 'list' })}
        onNotice={setNotice} />
    );
  }

  // ── Rename ────────────────────────────────────────────────────────────────
  if (view.at === 'rename') {
    return (
      <NameInput notice={notice} initial={view.preset.name} title="rename preset"
        onSubmit={(name) => { void renamePreset(view.preset, name); }}
        onCancel={() => setView({ at: 'editor', preset: view.preset })}
        onNotice={setNotice} />
    );
  }

  // ── Value editor for one key ───────────────────────────────────────────────
  if (view.at === 'editValue') {
    return (
      <ValueInput
        spec={view.spec}
        onCancel={() => setView({ at: 'editor', preset: view.preset })}
        onSubmit={(value) => {
          // ValueInput returns null for empty → that maps to "clear".
          // A real value → "set".
          void savePresetKey(view.preset, view.key, value);
        }}
      />
    );
  }

  // ── Preset editor (the 15 keys) ───────────────────────────────────────────
  if (view.at === 'editor') {
    const preset = view.preset;
    // Merge preset values with server cfg so providerChoices can see API keys.
    // Only non-null preset values should override — null means "clear", not
    // "the provider IS null" for catalog purposes.
    const merged: Record<string, unknown> = { ...(serverCfg ?? {}) };
    for (const [key, value] of Object.entries(preset.values)) {
      if (value !== null) merged[key] = value;
    }
    const choices = headedChoices(groups, (key) => {
      const state = keyState(preset.values, key.key);
      const value = preset.values[key.key];
      return {
        value: key.key,
        label: key.label,
        columns: [{ text: displayValue(state, value), width: 32 }],
        hint: hintForKey(state, value),
      };
    });
    return (
      <Screen title={`edit: ${preset.name}`} notice={notice} busy={busy}
        footer={[
          { key: 'enter', does: 'set a value' },
          { key: 'd', does: 'cycle: clear / leave unchanged' },
          { key: 'r', does: 'rename' },
          { key: 'esc', does: 'back' },
        ]}>
        <SelectList
          key="editor"
          initial={last}
          choices={choices}
          onSelect={(key) => {
            setLast(key);
            const info = groups.flatMap((group) => group.items).find((item) => item.key === key);
            if (!info) return;
            const spec: EditSpec = {
              title: info.label,
              choices: info.choices,
              type: serverEntries?.[key]?.meta.type ?? 'string',
              current: preset.values[key] ?? null,
              note: 'pick a value · empty = clear',
            };
            void finishSpec(key, spec, merged).then((spec) =>
              setView({ at: 'editValue', preset, key, spec }));
          }}
          onCancel={() => { setView({ at: 'list' }); setLast(preset.id); }}
          onKey={(char, key) => {
            if (char === 'r') { setView({ at: 'rename', preset }); return; }
            if (char !== 'd' || !key) return;
            // Cycle: set → clear → leave unchanged → clear → leave unchanged → ...
            const state = keyState(preset.values, key);
            if (state === 'set') {
              // set → clear
              void savePresetKey(preset, key, null);
            } else if (state === 'clear') {
              // clear → leave unchanged
              void savePresetKey(preset, key, undefined);
            } else {
              // leave → clear
              void savePresetKey(preset, key, null);
            }
          }}
        />
      </Screen>
    );
  }

  // ── Preset list ────────────────────────────────────────────────────────────
  if (!presets) {
    return <Screen title="presets" footer={[{ key: 'esc', does: 'close' }]}
      notice={notice} sub="loading…" />;
  }

  const listChoices = presetChoices(presets, groups);

  return (
    <Screen title="presets"
      sub={presets.length ? 'switch all agents at once' : 'no presets yet — [n] to create one'}
      notice={notice} busy={busy}
      footer={[
        { key: 'enter', does: 'apply', when: !!presets.length },
        { key: 'e', does: 'edit', when: !!presets.length },
        { key: 'n', does: 'new' },
        { key: 'd', does: 'delete', when: !!presets.length },
        { key: 'esc', does: 'close' },
      ]}>
      {presets.length === 0 ? (
        <EmptyHint onNew={() => { setNameText(''); setView({ at: 'name' }); }} onClose={onClose} />
      ) : (
        <SelectList
          key="list"
          initial={last}
          choices={listChoices}
          onSelect={(id) => {
            if (!id) return;         // the table header carries null
            const preset = presets.find((preset) => preset.id === id);
            if (!preset) return;
            void confirm(`apply "${preset.name}"?`, 'every session with nothing said yet moves to its model')
              .then((yes) => { if (yes) void applyPreset(preset); });
          }}
          onCancel={onClose}
          onKey={(char, id) => {
            if (char === 'n') { setNameText(''); setView({ at: 'name' }); return; }
            if (!id) return;
            const preset = presets.find((preset) => preset.id === id);
            if (!preset) return;
            if (char === 'e') { setLast(undefined); setView({ at: 'editor', preset }); return; }
            if (char === 'd') { void deletePreset(id); return; }
          }}
        />
      )}
    </Screen>
  );
}

/** The name prompt for a new preset — its own component so useInput can
 *  catch esc (hooks cannot live inside a conditional return). */
function NameInput({ notice, initial, title = 'new preset', onSubmit, onCancel, onNotice }: {
  notice?: string; initial: string; title?: string;
  onSubmit: (name: string) => void; onCancel: () => void;
  onNotice: (name: string | undefined) => void;
}) {
  const [text, setText] = useState(initial);
  useInput((_ch, key) => { if (key.escape) onCancel(); });
  return (
    <Screen title={title} footer={[{ key: 'enter', does: 'save' }, { key: 'esc', does: 'back' }]}
      notice={notice}>
      <Box>
        <FixedText color="cyan">{'  name: '}</FixedText>
        <TextInput
          value={text}
          onChange={(value) => { setText(value); onNotice(undefined); }}
          onSubmit={(value) => {
            const name = value.trim();
            if (!name) { onNotice('a preset needs a name'); return; }
            onSubmit(name);
          }}
          placeholder="a short name for this configuration"
        />
      </Box>
    </Screen>
  );
}

/** Shown when there are no presets yet. Catches esc and n. */
function EmptyHint({ onNew, onClose }: { onNew: () => void; onClose: () => void }) {
  useInput((_ch, key) => {
    if (key.escape) onClose();
    if (_ch === 'n') onNew();
  });
  return (
    <Box paddingLeft={2}>
      <Text dimColor>press [n] to create your first preset</Text>
    </Box>
  );
}
