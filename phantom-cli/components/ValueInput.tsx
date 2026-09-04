// Editing one value: a picker when the setting has fixed choices, a combobox
// when it has open-ended suggestions (the models.dev catalog), a line of text
// otherwise, masked when it is a secret. Nothing here knows what a setting
// means — it is handed a shape and returns a value.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { useState } from 'react';
import { TextInput } from './TextInput.js';
import { SelectList, type Choice } from './SelectList.js';
import { Screen } from './Screen.js';

export interface EditSpec {
  title: string;
  /** Fixed legal values; present => picker. */
  choices?: readonly string[];
  /** Plain names for those values, where the raw ones are cryptic on sight
   *  ("base" / "session"). The raw value is still what gets stored. */
  choiceLabels?: Record<string, string>;
  /** Open-ended suggestions (e.g. the models.dev catalog): a combobox — one
   *  field that filters this list as you type AND accepts a value outside it,
   *  so a custom id is always reachable in the same field. Distinct from
   *  `choices`, a closed set. Ignored when `choices` is present. */
  suggestions?: readonly string[];
  /** Pretty labels for suggestions; the raw suggestion is still what's stored
   *  and is shown alongside as the detail. */
  suggestionLabels?: Record<string, string>;
  /** Masked while typing and never echoed back. */
  secret?: boolean;
  type: 'string' | 'number' | 'boolean';
  current: unknown;
  /** Shown under the field — where the value lands, or why it may not apply. */
  note?: string;
}

export function ValueInput({ spec, onSubmit, onCancel }: {
  spec: EditSpec;
  onSubmit: (v: string | number | boolean | null) => void;
  onCancel: () => void;
}) {
  // A normal edit: the current value sits IN the field, cursor at the end,
  // and you change it. The empty-field-with-ghost-value shape is only right
  // where editing makes no sense — a secret is all-or-nothing, never shown
  // back, so it starts blank.
  const [text, setText] = useState(spec.secret ? '' : String(spec.current ?? ''));
  const [error, setError] = useState<string | undefined>();

  const choices = spec.type === 'boolean' ? ['true', 'false'] : spec.choices;
  // "true"/"false" is how it is stored, not how anyone reads a switch.
  const choiceLabels = spec.choiceLabels
    ?? (spec.type === 'boolean' ? { true: 'yes', false: 'no' } : undefined);
  // Open-ended suggestions become a combobox; a closed `choices` set wins over
  // them (a boolean or an enum is never free-typed).
  const hasSuggestions = !choices && !!spec.suggestions?.length;

  // The text path owns its own keys; the picker and combobox paths own theirs.
  // Called unconditionally (Rules of Hooks) and gated to the text path alone.
  useInput((_c, key) => { if (key.escape) onCancel(); }, { isActive: !choices && !hasSuggestions });

  if (hasSuggestions) {
    return <SuggestField spec={spec} onSubmit={onSubmit} onCancel={onCancel} />;
  }

  if (choices) {
    return (
      <Screen title={spec.title} sub={spec.note}
        footer={[{ key: 'enter', does: 'save' }, { key: 'esc', does: 'back' }]}>
        <SelectList
          choices={choices.map((c) => ({
            value: c,
            label: choiceLabels?.[c] ?? c,
            detail: String(spec.current) === c ? 'current value' : undefined,
          }))}
          onSelect={(v) => onSubmit(spec.type === 'boolean' ? v === 'true' : v)}
          onCancel={onCancel}
        />
      </Screen>
    );
  }

  const submit = (raw: string) => {
    const v = raw.trim();
    // Empty clears the setting rather than storing "" — "no endpoint" and
    // "an endpoint that is the empty string" are not the same thing.
    if (!v) return onSubmit(null);
    if (spec.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) { setError('must be a number'); return; }
      return onSubmit(n);
    }
    onSubmit(v);
  };

  return (
    <Screen title={spec.title} sub={spec.note} error={error}
      footer={[{ key: 'enter', does: 'save' }, { key: 'empty', does: 'clears it' }, { key: 'esc', does: 'back' }]}>
      <Box>
        <Text color="cyan">{'  > '}</Text>
        <TextInput
          value={text}
          onChange={(v) => { setText(v); setError(undefined); }}
          onSubmit={submit}
          mask={spec.secret ? '•' : undefined}
        />
      </Box>
    </Screen>
  );
}

// A combobox over `spec.suggestions`: ONE field. You type to filter the list;
// arrows move the highlight; enter takes the highlighted row. Whatever you type
// that isn't an exact suggestion also appears as a "use …" row at the bottom,
// so a custom id — one models.dev doesn't list yet, or a private one — is
// entered and submitted in the same field, no mode to switch into.
//
// The list IS SelectList — same rows, same window, same fixed hint block — in
// `pad` mode, so the list holds one height while typing filters it. Key
// ownership divides cleanly: TextInput takes the letters and, given no
// onSubmit, ignores enter; SelectList takes ↑/↓/enter/esc and, given no
// onKey, ignores the letters. The `key={query}` remount puts the highlight
// back on the best match after every keystroke.
function SuggestField({ spec, onSubmit, onCancel }: {
  spec: EditSpec;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');

  const cur = spec.current === null || spec.current === undefined ? '' : String(spec.current);
  const all = spec.suggestions ?? [];
  const labelOf = (s: string) => spec.suggestionLabels?.[s] ?? s;
  const q = query.trim().toLowerCase();

  const filtered = q
    ? all.filter((s) => s.toLowerCase().includes(q) || labelOf(s).toLowerCase().includes(q))
    : all;

  const choices: Choice<string>[] = filtered.map((s) => {
    const label = labelOf(s);
    const detail = [label !== s ? s : null, s === cur ? 'current' : null].filter(Boolean).join(' · ');
    return { value: s, label, detail: detail || undefined };
  });
  // The raw typed value, unless it already IS one of the suggestions.
  const typed = query.trim();
  if (typed && !all.includes(typed)) {
    choices.push({ value: typed, label: `use “${typed}”` });
  }

  return (
    <Screen title={spec.title} sub={spec.note}
      footer={[
        { key: 'type', does: 'filter' }, { key: '↑↓', does: 'move' },
        { key: 'enter', does: 'use highlighted' }, { key: 'esc', does: 'back' },
      ]}>
      <Box marginBottom={1}>
        <Text color="cyan">{'  > '}</Text>
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder={cur ? `filter or type an id — now: ${cur}` : 'filter or type an id…'}
        />
      </Box>
      <SelectList
        key={query}
        choices={choices}
        reserve={2}
        pad
        onSelect={onSubmit}
        onCancel={onCancel}
      />
    </Screen>
  );
}
