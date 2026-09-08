// Provider presets — saved configurations of all model settings that can be
// applied with one action.
//
// Three views:
//   list    the saved presets, with [enter] apply, [e] edit, [n] new, [d] delete
//   name    naming a new preset (TextInput on a Screen)
//   editor  the 11 model keys for one preset (SelectList + ValueInput, same
//           pattern as /model and /settings)
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
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { SelectList, type Choice } from './SelectList.js';
import { tableChoices, type TableRow } from './table.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import { TextInput } from './TextInput.js';
import { makeSettings } from '../settings.js';
import { PROVIDERS, type ConfigValue } from '../config.js';
import {
  buildModelSpec, providerForModelRow, MODEL_FOR_PROVIDER,
  type CatalogModel,
} from './Settings.js';
import type { Api } from '../request.js';
import { newId } from '../../core/ids.js';

/** The 11 model keys a preset may hold, in display order, grouped. */
const PRESET_GROUPS: Array<{ heading: string; keys: Array<{ key: string; label: string; choices?: readonly string[] }> }> = [
  { heading: 'coding agent', keys: [
    { key: 'provider', label: 'provider', choices: PROVIDERS },
    { key: 'model', label: 'model' },
    { key: 'base_url', label: 'endpoint' },
    { key: 'reasoning', label: 'reasoning', choices: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    { key: 'max_steps', label: 'steps per turn' },
  ] },
  { heading: 'assistant', keys: [
    { key: 'assistant_provider', label: 'provider', choices: PROVIDERS },
    { key: 'assistant_model', label: 'model' },
    { key: 'assistant_base_url', label: 'endpoint' },
    { key: 'assistant_reasoning', label: 'reasoning', choices: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    { key: 'assistant_max_steps', label: 'steps per turn' },
  ] },
  { heading: 'supervisor', keys: [
    { key: 'supervisor_provider', label: 'provider', choices: PROVIDERS },
    { key: 'supervisor_model', label: 'model' },
    { key: 'supervisor_base_url', label: 'endpoint' },
    { key: 'supervisor_reasoning', label: 'reasoning', choices: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    { key: 'supervisor_max_steps', label: 'steps per turn' },
  ] },
];

const ALL_KEYS = PRESET_GROUPS.flatMap((g) => g.keys.map((k) => k.key));

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
const cell = (v: unknown): string => (typeof v === 'string' ? v : '·');

/** The selection list's rows, through the shared table system: provider,
 *  model and reasoning each in their own aligned column under a header —
 *  the same shape /resume, /tasks and /archived draw. Replaces the old
 *  `detail` string that joined the three with ' · ' into one ragged blob. */
export function presetChoices(presets: Preset[]): Choice<string | null>[] {
  const rows = presets.map((p): TableRow<string> => ({
    value: p.id,
    cells: [p.name, cell(p.values.provider), cell(p.values.model), cell(p.values.reasoning)],
    hint: presetHint(p),
  }));
  return tableChoices('preset', [
    { title: 'provider', cap: 18 },   // fits 'openai-compatible' (17)
    { title: 'model', cap: 30 },      // long ids truncate, never wrap
    { title: 'reasoning' },           // the last column runs free
  ], rows);
}

/** The value column on the preset editor row. */
function displayValue(key: string, state: KeyState, value: unknown): string {
  if (state === 'leave') return '· leave unchanged';
  if (state === 'clear') return '∅ clear';
  return String(value);
}

/** The full hint for the list's hint block: all 11 keys laid out. */
function presetHint(p: Preset): string {
  const lines: string[] = [];
  for (const g of PRESET_GROUPS) {
    lines.push(`${g.heading}:`);
    for (const k of g.keys) {
      const s = keyState(p.values, k.key);
      const label = s === 'set' ? String(p.values[k.key])
        : s === 'clear' ? 'clear' : 'leave unchanged';
      lines.push(`  ${k.label}: ${label}`);
    }
  }
  return lines.join('\n');
}

function hintForKey(state: KeyState, value: unknown): string {
  if (state === 'set') return `apply writes this value: ${String(value)}`;
  if (state === 'clear') return 'clear — apply wipes this setting; the normal fallback takes over';
  return 'leave unchanged — apply won\'t touch this setting';
}

export function Presets({ api, onApplied, onClose }: {
  api: Api;
  /** Fired after a preset is applied so the app can rebuild agents. */
  onApplied: () => void;
  onClose: () => void;
}) {
  const settings = useMemo(() => makeSettings(api), [api]);
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [view, setView] = useState<View>({ at: 'list' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [last, setLast] = useState<string | undefined>();
  const [nameText, setNameText] = useState('');
  /** The armed-to-apply preset id. [enter] arms, [c] confirms. */
  const [applyArmed, setApplyArmed] = useState<string | null>(null);

  // Server settings — needed to filter provider choices to keyed providers.
  const [serverCfg, setServerCfg] = useState<Record<string, ConfigValue> | null>(null);
  useEffect(() => {
    void settings.read()
      .then((r) => setServerCfg(r))
      .catch((e: unknown) => setNotice(`server unreachable: ${(e as Error).message}`));
  }, [settings]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api('GET', '/presets') as Preset[];
      setPresets(r);
      setNotice(undefined);
    } catch (e) { setNotice(`could not load presets: ${(e as Error).message}`); setPresets([]); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // Model catalog loader — same pattern as Settings.tsx.
  const loadModels = useCallback(async (provider: string): Promise<CatalogModel[]> => {
    try {
      const r = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models?: CatalogModel[] };
      return Array.isArray(r?.models) ? r.models : [];
    } catch (e) {
      setNotice(`could not load the model list: ${(e as Error).message}`);
      return [];
    }
  }, [api]);

  const finishSpec = async (key: string, spec: EditSpec, values: Record<string, unknown>): Promise<EditSpec> => {
    const provider = providerForModelRow(key, values);
    const models = provider ? await loadModels(provider) : [];
    return buildModelSpec(key, spec, values, models);
  };

  // ── Apply ──────────────────────────────────────────────────────────────────
  const applyPreset = useCallback(async (p: Preset) => {
    setBusy(true);
    try {
      // Build a PATCH body from only the keys the preset has an opinion on.
      // set keys → their value, clear keys → null, leave-unchanged keys → skipped.
      const patch: Record<string, ConfigValue> = {};
      for (const k of ALL_KEYS) {
        if (!(k in p.values)) continue;            // leave unchanged — don't touch
        patch[k] = p.values[k] as ConfigValue;     // value or null
      }
      if (Object.keys(patch).length) {
        await settings.patch(patch);
      }
      setNotice(`preset applied: ${p.name}`);
      onApplied();
    } catch (e) { setNotice(`could not apply: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [settings, onApplied]);

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
    // — same UX as /model clearing the model when the provider changes.
    const modelKey = MODEL_FOR_PROVIDER[key];
    if (modelKey && value !== preset.values[key]) next[modelKey] = null;
    setBusy(true);
    try {
      await api('PUT', `/presets/${preset.id}`, { name: preset.name, values: next });
      const updated = { ...preset, values: next };
      setPresets((ps) => (ps ?? []).map((p) => p.id === preset.id ? updated : p));
      setView({ at: 'editor', preset: updated });
      setNotice(undefined);
    } catch (e) { setNotice(`could not save: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [api]);

  // ── Create ─────────────────────────────────────────────────────────────────
  const createPreset = useCallback(async (name: string) => {
    setBusy(true);
    try {
      const id = newId();
      // Clear is the default: a new preset resets every key it doesn't set.
      const values = Object.fromEntries(ALL_KEYS.map((k) => [k, null]));
      await api('PUT', `/presets/${id}`, { name, values });
      const preset: Preset = { id, name, values };
      await load();
      setView({ at: 'editor', preset });
      setNotice(undefined);
    } catch (e) { setNotice(`could not create: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [api, load]);

  // ── Rename ─────────────────────────────────────────────────────────────────
  const renamePreset = useCallback(async (preset: Preset, name: string) => {
    setBusy(true);
    try {
      await api('PUT', `/presets/${preset.id}`, { name, values: preset.values });
      const updated = { ...preset, name };
      setPresets((ps) => (ps ?? []).map((p) => p.id === preset.id ? updated : p));
      setView({ at: 'editor', preset: updated });
      setNotice(undefined);
    } catch (e) { setNotice(`could not rename: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [api]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const deletePreset = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await api('DELETE', `/presets/${id}`);
      await load();
      setNotice('preset deleted');
    } catch (e) { setNotice(`could not delete: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }, [api, load]);

  // ── Name input for a new preset ────────────────────────────────────────────
  if (view.at === 'name') {
    return (
      <NameInput notice={notice} initial={nameText}
        onSubmit={(n) => { void createPreset(n); }}
        onCancel={() => setView({ at: 'list' })}
        onNotice={setNotice} />
    );
  }

  // ── Rename ────────────────────────────────────────────────────────────────
  if (view.at === 'rename') {
    return (
      <NameInput notice={notice} initial={view.preset.name} title="rename preset"
        onSubmit={(n) => { void renamePreset(view.preset, n); }}
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
        onSubmit={(v) => {
          // ValueInput returns null for empty → that maps to "clear".
          // A real value → "set".
          void savePresetKey(view.preset, view.key, v);
        }}
      />
    );
  }

  // ── Preset editor (the 11 keys) ───────────────────────────────────────────
  if (view.at === 'editor') {
    const p = view.preset;
    // Merge preset values with server cfg so providerChoices can see API keys.
    // Only non-null preset values should override — null means "clear", not
    // "the provider IS null" for catalog purposes.
    const merged: Record<string, unknown> = { ...(serverCfg ?? {}) };
    for (const [k, v] of Object.entries(p.values)) {
      if (v !== null) merged[k] = v;
    }
    const choices: Choice<string>[] = [];
    for (const g of PRESET_GROUPS) {
      choices.push({ value: `#${g.heading}`, label: g.heading, heading: true });
      for (const k of g.keys) {
        const state = keyState(p.values, k.key);
        const v = p.values[k.key];
        choices.push({
          value: k.key,
          label: k.label,
          columns: [{ text: displayValue(k.key, state, v), width: 32 }],
          hint: hintForKey(state, v),
        });
      }
    }
    return (
      <Screen title={`edit: ${p.name}`} notice={notice} busy={busy}
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
          onSelect={(k) => {
            setLast(k);
            const info = PRESET_GROUPS.flatMap((g) => g.keys).find((x) => x.key === k);
            if (!info) return;
            const spec: EditSpec = {
              title: info.label,
              choices: info.choices,
              type: k.endsWith('max_steps') ? 'number' : 'string',
              current: p.values[k] ?? null,
              note: 'pick a value · empty = clear',
            };
            void finishSpec(k, spec, merged).then((s) =>
              setView({ at: 'editValue', preset: p, key: k, spec: s }));
          }}
          onCancel={() => { setView({ at: 'list' }); setLast(p.id); }}
          onKey={(ch, k) => {
            if (ch === 'r') { setView({ at: 'rename', preset: p }); return; }
            if (ch !== 'd' || !k) return;
            // Cycle: set → clear → leave unchanged → clear → leave unchanged → ...
            const state = keyState(p.values, k);
            if (state === 'set') {
              // set → clear
              void savePresetKey(p, k, null);
            } else if (state === 'clear') {
              // clear → leave unchanged
              void savePresetKey(p, k, undefined);
            } else {
              // leave → clear
              void savePresetKey(p, k, null);
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

  const listChoices = presetChoices(presets);

  return (
    <Screen title="presets"
      sub={presets.length ? 'switch all agents at once' : 'no presets yet — [n] to create one'}
      notice={notice} busy={busy}
      footer={[
        { key: 'c', does: 'confirm apply', when: !!applyArmed },
        { key: 'enter', does: 'apply', when: !!presets.length && !applyArmed },
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
            // [enter] arms the apply; notice tells the user to [c]onfirm.
            if (!id) return;         // the table header carries null
            const p = presets.find((x) => x.id === id);
            if (!p) return;
            setApplyArmed(id);
            setNotice(`apply "${p.name}"? [c] to confirm`);
          }}
          onCancel={() => { setApplyArmed(null); onClose(); }}
          onKey={(ch, id) => {
            // Any key other than c disarms.
            if (ch !== 'c') setApplyArmed(null);
            if (ch === 'c' && applyArmed) {
              const p = presets.find((x) => x.id === applyArmed);
              if (p) { setApplyArmed(null); void applyPreset(p); }
              return;
            }
            if (ch === 'n') { setNameText(''); setView({ at: 'name' }); return; }
            if (!id) return;
            const p = presets.find((x) => x.id === id);
            if (!p) return;
            if (ch === 'e') { setLast(undefined); setView({ at: 'editor', preset: p }); return; }
            if (ch === 'd') { void deletePreset(id); return; }
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
  onNotice: (n: string | undefined) => void;
}) {
  const [text, setText] = useState(initial);
  useInput((_ch, key) => { if (key.escape) onCancel(); });
  return (
    <Screen title={title} footer={[{ key: 'enter', does: 'save' }, { key: 'esc', does: 'back' }]}
      notice={notice}>
      <Box>
        <Text color="cyan">{'  name: '}</Text>
        <TextInput
          value={text}
          onChange={(v) => { setText(v); onNotice(undefined); }}
          onSubmit={(v) => {
            const n = v.trim();
            if (!n) { onNotice('a preset needs a name'); return; }
            onSubmit(n);
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
