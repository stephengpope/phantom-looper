// [d]uplicate's one question: which model should the copy run on?
//
// A duplicated session is born UNPINNED — it follows the model settings until
// its first new message, exactly like a fresh session — so this is the one
// moment "this conversation, another model" is possible. The first row keeps
// the settings as they are; every row below is a preset, applied exactly as
// /presets applies it, before the copy opens. esc makes no copy at all.
import { SelectList } from './SelectList.js';
import { Screen } from './Screen.js';
import { tableChoices, type TableRow } from './table.js';
import type { Preset } from './Presets.js';

/** The first row's value: keep the settings as they are. */
const KEEP_CURRENT = '__current__';

/** A summary cell: the value, or the system's empty-cell glyph (as /presets
 *  draws an unset key). */
const cell = (v: unknown): string => (typeof v === 'string' ? v : '·');

export function DuplicateModel({ presets, current, onPick, onCancel }: {
  presets: Preset[];
  /** The settings' current coding model, named on the first row. */
  current: { provider: string; model: string };
  /** A preset id, or null for "keep the current model". */
  onPick: (presetId: string | null) => void;
  onCancel: () => void;
}) {
  const rows: TableRow<string>[] = [
    { value: KEEP_CURRENT, cells: ['keep the current model', cell(current.provider), cell(current.model)],
      hint: 'the copy follows the settings as they are — /model and /presets still reach it until its first message' },
    ...presets.map((p): TableRow<string> => ({
      value: p.id,
      cells: [p.name, cell(p.values.provider), cell(p.values.model)],
      hint: `apply "${p.name}" (as /presets does), then duplicate — the copy runs on it until its first message`,
    })),
  ];
  return (
    <Screen title="duplicate — which model?"
      sub="the copy starts unsettled: this choice holds until its first message, then it is pinned"
      footer={[{ key: 'enter', does: 'duplicate' }, { key: 'esc', does: 'cancel' }]}>
      <SelectList
        choices={tableChoices('preset',
          [{ title: 'provider', cap: 18 }, { title: 'model', cap: 30 }], rows)}
        onSelect={(v) => { if (v) onPick(v === KEEP_CURRENT ? null : v); }}
        onCancel={onCancel} />
    </Screen>
  );
}
