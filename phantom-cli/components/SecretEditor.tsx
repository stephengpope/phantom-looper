// The secret editor — one card-style popup, every field on screen at once
// (the CardEditor's shape: focused row is a live TextInput, tab/↑↓ walk the
// rows, the ❯ marker and cyan label say where you are). UNLIKE the card it
// never auto-saves: a half-entered secret is nothing to store, so [esc]
// KILLS the whole thing and only the Save row writes. Value is masked as it
// is typed and never echoed back.
//
// Two modes: new — every row live, Where cycling through EVERY save target
// (global first, then each workspace by name); edit — name and layer are
// the row's identity and sit fixed in the header, description and value
// edit (value re-entered whole: the server never hands a secret back).
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { useRef, useState } from 'react';
import { isMouseInput } from '../mouse.js';
import { TextInput } from './TextInput.js';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A place a secret can live: global (id null) or one workspace. */
export interface SecretTarget { id: string | null; label: string }

export interface SecretDraft {
  name: string; description: string; value: string;
  /** null = global, else the workspace id. */
  workspaceId: string | null;
}

export function SecretEditor({ mode, initial, targets, isActive = true, onSave, onCancel }: {
  mode: 'new' | 'edit';
  /** edit: the row being edited (value always starts empty). new: ignored. */
  initial?: { name: string; description: string; workspaceId: string | null; scopeLabel: string };
  /** Every place a new secret can go — global first, then the workspaces. */
  targets: SecretTarget[];
  isActive?: boolean;
  onSave: (d: SecretDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<SecretDraft>({
    name: mode === 'edit' ? initial!.name : '',
    description: mode === 'edit' ? initial!.description : '',
    value: '',
    workspaceId: mode === 'edit' ? initial!.workspaceId : null,
  });
  const [error, setError] = useState<string | undefined>();

  // Row list is fixed per mode; focus lives in a ref (two keys in one React
  // batch both need the fresh index — the CardEditor/TextInput rule).
  const rows: string[] = mode === 'new'
    ? ['name', 'description', 'value', ...(targets.length > 1 ? ['where'] : []), 'save']
    : ['description', 'value', 'save'];
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
    if (!NAME.test(d.name)) { setError('name: lowercase letters, digits, underscores — starting with a letter'); return; }
    if (!d.value) { setError('value: required — a secret with no value is nothing to store'); return; }
    onSave(d);
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
          onChange={(v) => { setError(undefined); setDraft((d) => ({ ...d, [k]: v })); }}
          onSubmit={() => move(1)} placeholder={placeholder} />
      : draft[k]
        ? <Text wrap="truncate">{mask ? mask.repeat(draft[k].length) : draft[k]}</Text>
        : <Text dimColor>{placeholder}</Text>;

  const whereLabel = targets.find((t) => t.id === draft.workspaceId)?.label ?? 'global — every workspace';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {mode === 'new' ? 'new secret' : draft.name}
          {mode === 'edit' ? <Text dimColor>  {initial!.scopeLabel}</Text> : null}
        </Text>
        <Text dimColor>nothing saves until Save</Text>
      </Box>
      {mode === 'new' && (
        <Box marginTop={1}>
          {label('Name', 'name')}
          {input('name', 'lowercase_with_underscores — what the agent asks for')}
        </Box>
      )}
      <Box marginTop={1}>
        {label('Description', 'description')}
        {input('description', 'one line the agent reads to know when to use it')}
      </Box>
      <Box marginTop={1}>
        {label('Value', 'value')}
        {input('value', 'the secret itself — stored encrypted, never shown back', '•')}
      </Box>
      {mode === 'new' && targets.length > 1 && (
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
              {focused === 'save' ? '[enter] saves' : `stores ${mode === 'new' ? whereLabel : 'the new value'}`}
            </Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[tab/↑↓] move · [enter] next · [esc] kill — nothing is kept</Text>
      </Box>
    </Box>
  );
}
