// The secret editor — one card-style popup, every field on screen at once
// (the CardEditor's shape: focused row is a live TextInput, tab/↑↓ walk the
// rows, the ❯ marker and cyan label say where you are). UNLIKE the card it
// never auto-saves: a half-entered secret is nothing to store, so [esc]
// KILLS the whole thing and only the Save row writes. Value is masked as it
// is typed and never echoed back.
//
// The SAME rows in both modes — Name, Description, Value, Where, Save —
// nothing is locked. new: value required. edit: the row's name, description
// and layer are pre-filled and all editable; the value starts EMPTY and
// empty means "keep it" (the server never hands a secret back, and a typo
// in a description must not cost re-pasting the token). A changed name or
// Where is a move — the screen that owns the list does it.
import { Box } from 'ink';
import { useInput } from './useInput.js';
import { Text } from './Text.js';
import { useRef, useState } from 'react';
import { isMouseInput } from '../mouse.js';
import { TextInput } from './TextInput.js';
import { secretName, SECRET_NAME_RULE } from '../../core/secretName.js';

/** A place a secret can live: global (id null) or one workspace. */
export interface SecretTarget { id: string | null; label: string }

export interface SecretDraft {
  name: string; description: string;
  /** edit: '' = keep the stored value. */
  value: string;
  /** null = global, else the workspace id. */
  workspaceId: string | null;
}

export function SecretEditor({ mode, initial, targets, isActive = true, onSave, onCancel }: {
  mode: 'new' | 'edit';
  /** edit: the row being edited (value always starts empty).
   *  new: where the Where row starts (the list's current workspace filter). */
  initial?: Partial<Omit<SecretDraft, 'value'>>;
  /** Every place a secret can go — global first, then the workspaces. */
  targets: SecretTarget[];
  isActive?: boolean;
  onSave: (d: SecretDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<SecretDraft>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    value: '',
    workspaceId: initial?.workspaceId ?? null,
  });
  const [error, setError] = useState<string | undefined>();

  // Focus lives in a ref (two keys in one React batch both need the fresh
  // index — the CardEditor/TextInput rule).
  const rows = ['name', 'description', 'value', ...(targets.length > 1 ? ['where'] : []), 'save'];
  const atRef = useRef(0);
  const [, bump] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const at = Math.min(atRef.current, rows.length - 1);
  const focused = rows[at];
  const move = (d: number) => { atRef.current = (at + d + rows.length) % rows.length; bump((n) => n + 1); };

  /** Cycle Where through the targets, either direction. */
  const cycleWhere = (dir: 1 | -1) => setDraft((d) => {
    const i = targets.findIndex((t) => t.id === d.workspaceId);
    const next = targets[(Math.max(i, 0) + dir + targets.length) % targets.length];
    return { ...d, workspaceId: next.id };
  });

  const save = () => {
    const d = draftRef.current;
    const name = secretName(d.name);
    if (!name) { setError(`name: ${SECRET_NAME_RULE}`); return; }
    if (mode === 'new' && !d.value) { setError('value: required — a secret with no value is nothing to store'); return; }
    onSave({ ...d, name });
  };

  useInput((ch, key) => {
    if (isMouseInput(ch)) return;
    if (key.escape) { onCancel(); return; }
    if (key.tab || key.downArrow) { move(key.shift ? -1 : 1); return; }
    if (key.upArrow) { move(-1); return; }
    const r = rows[Math.min(atRef.current, rows.length - 1)];
    if (r === 'where') {
      if (key.return || ch === ' ' || key.rightArrow) { cycleWhere(1); return; }
      if (key.leftArrow) { cycleWhere(-1); return; }
    }
    if (r === 'save' && (key.return || ch === ' ')) save();
  }, { isActive });

  // 15 = the 2-cell marker + "Description" (11, the widest label) + the
  // 2-cell gutter INSIDE the width — table.ts's rule, so the longest label
  // never sits flush against the value being typed.
  const label = (text: string, k: string) => (
    <Box width={15} flexShrink={0}>
      <Text color={focused === k ? 'cyan' : undefined} dimColor={focused !== k} bold={focused === k}>
        {focused === k ? '❯ ' : '  '}{text}
      </Text>
    </Box>
  );

  /** The one live input, on whichever row holds focus (the CardEditor's). */
  const input = (k: 'name' | 'description' | 'value', placeholder: string, mask?: string) =>
    focused === k
      ? <TextInput value={draft[k]} mask={mask}
          onChange={(v) => { setError(undefined); setDraft((d) => ({ ...d, [k]: k === 'name' ? v.toUpperCase() : v })); }}
          onSubmit={() => move(1)} placeholder={placeholder} />
      : draft[k]
        ? <Text wrap="truncate">{mask ? mask.repeat(draft[k].length) : draft[k]}</Text>
        : <Text dimColor>{placeholder}</Text>;

  const whereLabel = targets.find((t) => t.id === draft.workspaceId)?.label ?? 'global — every workspace';
  const moved = mode === 'edit'
    && (draft.name !== initial?.name || draft.workspaceId !== (initial?.workspaceId ?? null));
  const saveSays = mode === 'new' ? `stores ${whereLabel}`
    : moved ? `moves it to ${draft.name || '?'} · ${whereLabel}`
      : draft.value ? 'stores the new value' : 'keeps the value, saves the rest';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{mode === 'new' ? 'new secret' : initial?.name}</Text>
        <Text dimColor>nothing saves until Save</Text>
      </Box>
      <Box marginTop={1}>
        {label('Name', 'name')}
        {input('name', 'MY_API_KEY — what the agent asks for')}
      </Box>
      <Box marginTop={1}>
        {label('Description', 'description')}
        {input('description', 'one line the agent reads to know when to use it')}
      </Box>
      <Box marginTop={1}>
        {label('Value', 'value')}
        {input('value', mode === 'new'
          ? 'the secret itself — stored encrypted, never shown back'
          : 'leave empty to keep the stored value — never shown back', '•')}
      </Box>
      {targets.length > 1 && (
        <Box marginTop={1}>
          {label('Where', 'where')}
          <Text color={draft.workspaceId !== null ? 'cyan' : undefined} dimColor={draft.workspaceId === null}>
            {whereLabel}
          </Text>
          {focused === 'where' ? <Text dimColor> · [enter/←→] next of {targets.length}</Text> : null}
        </Box>
      )}
      <Box marginTop={1}>
        {label('Save', 'save')}
        {error
          ? <Text color="red" wrap="truncate">{error}</Text>
          : <Text dimColor={focused !== 'save'} color={focused === 'save' ? 'green' : undefined}>
              {focused === 'save' ? `[enter] saves — ${saveSays}` : saveSays}
            </Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[tab/↑↓] move · [enter] next · [esc] kill — nothing is kept</Text>
      </Box>
    </Box>
  );
}
