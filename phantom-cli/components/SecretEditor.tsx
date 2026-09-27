// The secret editor — one card-style popup, every field on screen at once
// (the CardEditor's shape: focused row is a live TextInput, tab/↑↓ walk the
// rows, the ❯ marker and cyan label say where you are). It AUTO-SAVES the
// card's way, with one difference forced by the data: a secret has no id —
// its name + Where IS the row — so a field saves when you LEAVE it (enter,
// tab, arrows, esc), not on every keystroke, or typing a name would write a
// row per pause. There is no Save row. Esc saves the field you are on and
// closes. Value is masked as it is typed and never echoed back.
//
// The SAME rows in both modes — Name, Description, Value, Where. new:
// nothing is written until the name is valid AND a value is typed; from
// then on it is an edit. edit: name, description and Where are pre-filled;
// the value starts EMPTY and empty means "keep it" (the server never hands
// a secret back, and a typo in a description must not cost re-pasting the
// token). A changed name or Where is a move — the screen that owns the list
// does it. Saves queue one behind another, so a value write always lands
// before the move that would read it.
import { Box } from 'ink';
import { useInput } from './useInput.js';
import { Text } from './Text.js';
import { useRef, useState } from 'react';
import { isMouseInput } from '../mouse.js';
import { TextInput } from './TextInput.js';
import { secretName, SECRET_NAME_RULE } from '../../core/secretName.js';

/** A place a secret can live: global (id null) or one workspace. */
export interface SecretTarget { id: string | null; label: string }

/** Where a secret is stored: the two that make it one row. */
export interface SecretId { name: string; workspaceId: string | null }

export interface SecretDraft extends SecretId {
  description: string;
  /** '' = keep the stored value. */
  value: string;
}

export function SecretEditor({ mode, initial, targets, isActive = true, onSave, onClose }: {
  mode: 'new' | 'edit';
  /** edit: the row being edited (value always starts empty).
   *  new: where the Where row starts (the list's current workspace filter). */
  initial?: Partial<Omit<SecretDraft, 'value'>>;
  /** Every place a secret can go — global first, then the workspaces. */
  targets: SecretTarget[];
  isActive?: boolean;
  /** Write the draft; `from` is where it is stored now (absent = create).
   *  Rejects with the reason when the server would not take it. */
  onSave: (d: SecretDraft, from?: SecretId) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SecretDraft>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    value: '',
    workspaceId: initial?.workspaceId ?? null,
  });
  const [error, setError] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<'rest' | 'saving' | 'saved' | 'failed'>('rest');

  // Focus lives in a ref (two keys in one React batch both need the fresh
  // index — the CardEditor/TextInput rule).
  const rows = ['name', 'description', 'value', ...(targets.length > 1 ? ['where'] : [])];
  const atRef = useRef(0);
  const [, bump] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const at = Math.min(atRef.current, rows.length - 1);
  const focused = rows[at];

  // What the server holds: where the row is (null until a new one is
  // created) and the last draft it took — a leave that changed nothing
  // sends nothing.
  const storedRef = useRef<SecretId | null>(
    mode === 'edit' && initial?.name ? { name: initial.name, workspaceId: initial.workspaceId ?? null } : null);
  const sentRef = useRef<Omit<SecretDraft, 'value'> | null>(
    storedRef.current ? { name: draft.name, description: draft.description, workspaceId: draft.workspaceId } : null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  /** Save the draft if it differs from what the server holds. Runs on
   *  leaving a field. Queued behind any save still in flight. */
  const commit = () => {
    const d = draftRef.current;
    const stored = storedRef.current;
    const name = secretName(d.name);
    // Nothing exists yet and there is not enough to create: wait.
    if (!stored && (!name || !d.value)) {
      if (d.value && !name) setError(`name: ${SECRET_NAME_RULE}`);
      return;
    }
    if (!name) { setError(`name: ${SECRET_NAME_RULE}`); return; }
    const sent = sentRef.current;
    const changed = !sent || d.value !== '' || sent.name !== name
      || sent.description !== d.description || sent.workspaceId !== d.workspaceId;
    if (!changed) return;
    const out: SecretDraft = { ...d, name };
    setError(undefined);
    setSaveState('saving');
    queueRef.current = queueRef.current
      .then(() => onSave(out, stored ?? undefined))
      .then(() => {
        storedRef.current = { name, workspaceId: out.workspaceId };
        sentRef.current = { name, description: out.description, workspaceId: out.workspaceId };
        // The value went; the field goes back to "keep it".
        setDraft((cur) => ({ ...cur, value: '' }));
        setSaveState('saved');
      }, (e: Error) => { setError(e.message); setSaveState('failed'); });
  };

  const move = (d: number) => {
    commit();
    atRef.current = (at + d + rows.length) % rows.length;
    bump((n) => n + 1);
  };

  /** Cycle Where through the targets, either direction. */
  const cycleWhere = (dir: 1 | -1) => setDraft((d) => {
    const i = targets.findIndex((t) => t.id === d.workspaceId);
    const next = targets[(Math.max(i, 0) + dir + targets.length) % targets.length];
    return { ...d, workspaceId: next.id };
  });

  useInput((ch, key) => {
    if (isMouseInput(ch)) return;
    if (key.escape) { commit(); onClose(); return; }
    if (key.tab || key.downArrow) { move(key.shift ? -1 : 1); return; }
    if (key.upArrow) { move(-1); return; }
    // Enter on a text row is the TextInput's (onSubmit moves); Where has no
    // input, so it is taken here.
    const r = rows[Math.min(atRef.current, rows.length - 1)];
    if (r === 'where') {
      if (key.return) { move(1); return; }
      if (ch === ' ' || key.rightArrow) { cycleWhere(1); return; }
      if (key.leftArrow) { cycleWhere(-1); return; }
    }
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

  const exists = storedRef.current !== null;
  const whereLabel = targets.find((t) => t.id === draft.workspaceId)?.label ?? 'global — every workspace';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{exists ? storedRef.current?.name : 'new secret'}</Text>
        {saveState === 'saving' ? <Text color="yellow">saving…</Text>
          : saveState === 'saved' ? <Text color="green">saved ✓</Text>
          : saveState === 'failed' ? <Text color="red">save failed — edit to retry</Text>
          : <Text dimColor>{exists ? 'saves as you leave a field · esc closes' : 'stored once it has a name and a value'}</Text>}
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
        {input('value', exists
          ? 'leave empty to keep the stored value — never shown back'
          : 'the secret itself — stored encrypted, never shown back', '•')}
      </Box>
      {targets.length > 1 && (
        <Box marginTop={1}>
          {label('Where', 'where')}
          <Text color={draft.workspaceId !== null ? 'cyan' : undefined} dimColor={draft.workspaceId === null}>
            {whereLabel}
          </Text>
          {focused === 'where' ? <Text dimColor> · [space/←→] next of {targets.length}</Text> : null}
        </Box>
      )}
      <Box marginTop={1}>
        {error
          ? <Text color="red" wrap="truncate">{error}</Text>
          : <Text dimColor>[tab/↑↓] move · [enter] next · [esc] close</Text>}
      </Box>
    </Box>
  );
}
