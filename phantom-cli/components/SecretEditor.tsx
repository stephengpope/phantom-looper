// The secret editor — one card-style popup, every field on screen at once
// (the CardEditor's shape: focused row is a live TextInput, tab/↑↓ walk the
// rows, the ❯ marker and cyan label say where you are). It AUTO-SAVES the
// card's way, with one difference forced by the data: a secret has no id —
// its name + Where IS the row — so a field saves when you LEAVE it (enter,
// tab, arrows, esc), not on every keystroke, or typing a name would write a
// row per pause. There is no Save row. Esc saves the field you are on and
// closes. Value is masked as it is typed and never echoed back.
//
// Two types of secret, and the Type row decides which rows exist below it:
//   token — Name, Description, Type, Value, Where. The value is pasted.
//   oauth — Name, Description, Type, Provider, Setup, Scopes, Client id,
//           Client secret, (Auth URL, Token URL for a custom provider),
//           Where, Connect. The value is GRANTED: Connect opens the browser,
//           the server keeps the tokens and hands the agent a live one.
// new: nothing is written until the name is valid AND the type's own
// essentials are typed (a value; a provider + client id); from then on it is
// an edit. edit: everything is pre-filled but the secret fields, which start
// EMPTY and empty means "keep it" (the server never hands a secret back).
// The type is fixed once stored. A changed name or Where is a move — the
// screen that owns the list does it — for a token; an OAuth secret's grant
// cannot travel (the server never hands tokens back), so its name and Where
// are fixed too. Saves queue one behind another, so a value write always
// lands before the move that would read it.
import { Box } from 'ink';
import { useInput } from './useInput.js';
import { Text } from './Text.js';
import { useRef, useState } from 'react';
import { isMouseInput } from '../mouse.js';
import { TextInput } from './TextInput.js';
import { secretName, SECRET_NAME_RULE } from '@phantom-agent-sdk/client';
import type { OAuthPreset, OAuthState } from '@phantom-agent-sdk/client';

/** A place a secret can live: global (id null) or one project. */
export interface SecretTarget { id: string | null; label: string }

/** Where a secret is stored: the two that make it one row. */
export interface SecretId { name: string; projectId: string | null }

export type SecretType = 'token' | 'oauth';

/** The OAuth rows as typed: scopes are one line, space-separated. */
export interface OAuthDraft {
  provider: string;
  scopes: string;
  clientId: string;
  /** '' = keep the stored one. */
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
}

export interface SecretDraft extends SecretId {
  description: string;
  type: SecretType;
  /** token: '' = keep the stored value. */
  value: string;
  oauth: OAuthDraft;
}

const EMPTY_OAUTH: OAuthDraft = { provider: '', scopes: '', clientId: '', clientSecret: '', authUrl: '', tokenUrl: '' };

/** The connection as the row shows it. */
function connection(state: OAuthState | undefined): string {
  if (!state || state.status === 'disconnected') return 'not connected';
  const who = state.accountEmail ? ` · ${state.accountEmail}` : '';
  return state.status === 'expired' ? `expired${who}` : `connected${who}`;
}

export function SecretEditor({ mode, initial, targets, presets, isActive = true, onSave, onConnect, onClose }: {
  mode: 'new' | 'edit';
  /** edit: the row being edited (the secret fields always start empty).
   *  new: where the Where row starts (the list's current project filter). */
  initial?: Partial<Omit<SecretDraft, 'value' | 'oauth'>> & { oauth?: OAuthState };
  /** Every place a secret can go — global first, then the projects. */
  targets: SecretTarget[];
  /** The OAuth providers the server offers, and the redirect to register with them. */
  presets: { presets: OAuthPreset[]; redirectUri: string };
  isActive?: boolean;
  /** Write the draft; `from` is where it is stored now (absent = create).
   *  Rejects with the reason when the server would not take it. */
  onSave: (draft: SecretDraft, from?: SecretId) => Promise<void>;
  /** Run the browser round-trip for a stored OAuth secret; resolves with its state. */
  onConnect: (id: SecretId, signal: AbortSignal) => Promise<OAuthState>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SecretDraft>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    type: initial?.type ?? (initial?.oauth ? 'oauth' : 'token'),
    value: '',
    projectId: initial?.projectId ?? null,
    oauth: initial?.oauth
      ? { ...EMPTY_OAUTH, provider: initial.oauth.provider, scopes: initial.oauth.scopes.join(' '), clientId: initial.oauth.clientId,
          authUrl: initial.oauth.authUrl ?? '', tokenUrl: initial.oauth.tokenUrl ?? '' }
      : { ...EMPTY_OAUTH, provider: presets.presets[0]?.id ?? '' },
  });
  const [error, setError] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<'rest' | 'saving' | 'saved' | 'failed'>('rest');
  const [state, setState] = useState<OAuthState | undefined>(initial?.oauth);
  const [connecting, setConnecting] = useState<AbortController | null>(null);
  const [connectError, setConnectError] = useState<string | undefined>();
  /** The Setup row's pick — a convenience that fills Scopes; never stored. */
  const [setup, setSetup] = useState<string | null>(null);

  const preset = presets.presets.find((preset) => preset.id === draft.oauth.provider);
  const oauth = draft.type === 'oauth';

  // Focus lives in a ref (two keys in one React batch both need the fresh
  // index — the CardEditor/TextInput rule).
  const rows = [
    'name', 'description', 'type',
    ...(oauth
      ? ['provider', ...(preset?.setups?.length ? ['setup'] : []), 'scopes', 'clientId',
        ...(preset?.clientAuth === 'none' ? [] : ['clientSecret']),
        ...(preset?.custom ? ['authUrl', 'tokenUrl'] : [])]
      : ['value']),
    ...(targets.length > 1 ? ['where'] : []),
    ...(oauth ? ['connect'] : []),
  ];
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
    mode === 'edit' && initial?.name ? { name: initial.name, projectId: initial.projectId ?? null } : null);
  const sentRef = useRef<string | null>(storedRef.current ? plain(draft) : null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  /** The draft without its secret fields — what "changed" compares. */
  function plain(draft: SecretDraft): string {
    const { value, oauth: { clientSecret, ...oauth }, ...rest } = draft;
    void value; void clientSecret;
    return JSON.stringify({ ...rest, oauth });
  }

  /** Save the draft if it differs from what the server holds. Runs on
   *  leaving a field. Queued behind any save still in flight. */
  const commit = (): Promise<void> => {
    const draft = draftRef.current;
    const stored = storedRef.current;
    const name = secretName(draft.name);
    const essentials = draft.type === 'oauth' ? Boolean(draft.oauth.provider && draft.oauth.clientId.trim()) : Boolean(draft.value);
    // Nothing exists yet and there is not enough to create: wait.
    if (!stored && (!name || !essentials)) {
      if (essentials && !name) setError(`name: ${SECRET_NAME_RULE}`);
      return queueRef.current;
    }
    if (!name) { setError(`name: ${SECRET_NAME_RULE}`); return queueRef.current; }
    const out: SecretDraft = { ...draft, name };
    const changed = sentRef.current !== plain(out) || draft.value !== '' || draft.oauth.clientSecret !== '';
    if (!changed) return queueRef.current;
    setError(undefined);
    setSaveState('saving');
    queueRef.current = queueRef.current
      .then(() => onSave(out, stored ?? undefined))
      .then(() => {
        storedRef.current = { name, projectId: out.projectId };
        sentRef.current = plain(out);
        // The secrets went; the fields go back to "keep it".
        setDraft((cur) => ({ ...cur, value: '', oauth: { ...cur.oauth, clientSecret: '' } }));
        setSaveState('saved');
      }, (error: Error) => { setError(error.message); setSaveState('failed'); });
    return queueRef.current;
  };

  const move = (delta: number) => {
    void commit();
    atRef.current = (at + delta + rows.length) % rows.length;
    bump((tick) => tick + 1);
  };

  /** Cycle a pick row through its choices, either direction. */
  const cycle = <T,>(choices: T[], current: (choice: T) => boolean, dir: 1 | -1): T | undefined => {
    if (!choices.length) return undefined;
    const i = choices.findIndex(current);
    return choices[(Math.max(i, 0) + dir + choices.length) % choices.length];
  };
  const cycleWhere = (dir: 1 | -1) => setDraft((draft) => {
    const next = cycle(targets, (target) => target.id === draft.projectId, dir);
    return next ? { ...draft, projectId: next.id } : draft;
  });
  const cycleType = () => setDraft((draft) => ({ ...draft, type: draft.type === 'token' ? 'oauth' : 'token' }));
  const cycleProvider = (dir: 1 | -1) => {
    setSetup(null);
    setDraft((draft) => {
      const next = cycle(presets.presets, (preset) => preset.id === draft.oauth.provider, dir);
      return next ? { ...draft, oauth: { ...draft.oauth, provider: next.id, scopes: next.defaultScopes.join(' ') } } : draft;
    });
  };
  const cycleSetup = (dir: 1 | -1) => {
    const setups = preset?.setups ?? [];
    const next = cycle(setups, (choice) => choice.id === setup, dir);
    if (!next) return;
    setSetup(next.id);
    setDraft((draft) => ({ ...draft, oauth: { ...draft.oauth, scopes: next.scopes.join(' ') } }));
  };

  /** The Connect row: save what is typed, then run the browser round-trip. */
  const connect = () => {
    if (connecting) return;
    const controller = new AbortController();
    setConnecting(controller);
    setConnectError(undefined);
    void commit()
      .then(() => {
        const stored = storedRef.current;
        if (!stored) throw new Error('fill in the name, provider and client id first');
        return onConnect(stored, controller.signal);
      })
      .then((state) => setState(state), (error: Error) => setConnectError(error.message))
      .finally(() => setConnecting(null));
  };

  useInput((char, key) => {
    if (isMouseInput(char)) return;
    if (key.escape) {
      if (connecting) { connecting.abort(); return; }
      void commit(); onClose(); return;
    }
    if (connecting) return;
    if (key.tab || key.downArrow) { move(key.shift ? -1 : 1); return; }
    if (key.upArrow) { move(-1); return; }
    // Enter on a text row is the TextInput's (onSubmit moves); the pick and
    // action rows have no input, so they are taken here.
    const row = rows[Math.min(atRef.current, rows.length - 1)];
    const pick = (dir: 1 | -1) => {
      if (row === 'where') { if (!(oauth && mode === 'edit')) cycleWhere(dir); }
      else if (row === 'type' && mode === 'new') cycleType();
      else if (row === 'provider') cycleProvider(dir);
      else if (row === 'setup') cycleSetup(dir);
    };
    if (row === 'connect' && key.return) { connect(); return; }
    if (row === 'name' && oauth && mode === 'edit') { if (key.return) move(1); return; }
    if (['where', 'type', 'provider', 'setup'].includes(row)) {
      if (key.return) { move(1); return; }
      if (char === ' ' || key.rightArrow) { pick(1); return; }
      if (key.leftArrow) { pick(-1); return; }
    }
  }, { isActive });

  // 17 = the 2-cell marker + "Client secret" (13, the widest label) + the
  // 2-cell gutter INSIDE the width — table.ts's rule, so the longest label
  // never sits flush against the value being typed.
  const label = (text: string, field: string) => (
    <Box width={17} flexShrink={0}>
      <Text color={focused === field ? 'cyan' : undefined} dimColor={focused !== field} bold={focused === field}>
        {focused === field ? '❯ ' : '  '}{text}
      </Text>
    </Box>
  );

  type TextField = 'name' | 'description' | 'value' | 'scopes' | 'clientId' | 'clientSecret' | 'authUrl' | 'tokenUrl';
  const read = (field: TextField): string => (field in draft.oauth ? draft.oauth[field as keyof OAuthDraft] : draft[field as 'name' | 'description' | 'value']);
  const write = (field: TextField, value: string) => setDraft((draft) => (field in draft.oauth
    ? { ...draft, oauth: { ...draft.oauth, [field]: value } }
    : { ...draft, [field]: field === 'name' ? value.toUpperCase() : value }));

  /** The one live input, on whichever row holds focus (the CardEditor's). */
  const input = (field: TextField, placeholder: string, mask?: string) =>
    focused === field
      ? <TextInput value={read(field)} mask={mask}
          onChange={(value) => { setError(undefined); write(field, value); }}
          onSubmit={() => move(1)} placeholder={placeholder} />
      : read(field)
        ? <Text wrap="truncate">{mask ? mask.repeat(read(field).length) : read(field)}</Text>
        : <Text dimColor>{placeholder}</Text>;

  /** A pick row: the choice, and how to change it while focused. */
  const pickRow = (field: string, text: string, chosen: boolean, how: string) => (
    <Box marginTop={1}>
      {label(field === 'where' ? 'Where' : field === 'type' ? 'Type' : field === 'provider' ? 'Provider' : 'Setup', field)}
      <Text color={chosen ? 'cyan' : undefined} dimColor={!chosen}>{text}</Text>
      {focused === field ? <Text dimColor> · {how}</Text> : null}
    </Box>
  );

  const exists = storedRef.current !== null;
  /** A stored OAuth secret: its name and Where cannot change (see the header). */
  const fixed = oauth && mode === 'edit';
  const whereLabel = targets.find((target) => target.id === draft.projectId)?.label ?? 'global — every project';
  const setupLabel = (preset?.setups ?? []).find((choice) => choice.id === setup);
  const hint = error ? undefined
    : focused === 'connect' ? `register this redirect with the provider: ${presets.redirectUri}`
    : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{exists ? storedRef.current?.name : 'new secret'}</Text>
        {saveState === 'saving' ? <Text color="yellow">saving…</Text>
          : saveState === 'saved' ? <Text color="green">saved ✓</Text>
          : saveState === 'failed' ? <Text color="red">save failed — edit to retry</Text>
          : <Text dimColor>{exists ? 'saves as you leave a field · esc closes'
            : oauth ? 'stored once it has a name, provider and client id' : 'stored once it has a name and a value'}</Text>}
      </Box>
      <Box marginTop={1}>
        {label('Name', 'name')}
        {fixed ? <Text>{draft.name}{focused === 'name' ? <Text dimColor> · fixed once connected</Text> : null}</Text>
          : input('name', 'MY_API_KEY — what the agent asks for')}
      </Box>
      <Box marginTop={1}>
        {label('Description', 'description')}
        {input('description', 'one line the agent reads to know when to use it')}
      </Box>
      {pickRow('type', draft.type === 'oauth' ? 'oauth — connect an account' : 'token — paste a value', true,
        mode === 'new' ? '[space/←→] token / oauth' : 'fixed once stored')}
      {oauth ? (
        <>
          {pickRow('provider', preset?.label ?? draft.oauth.provider, true, `[space/←→] next of ${presets.presets.length}`)}
          {preset?.setups?.length ? pickRow('setup', setupLabel ? `${setupLabel.label}${setupLabel.description ? ` — ${setupLabel.description}` : ''}` : 'pick one to fill Scopes',
            Boolean(setupLabel), `[space/←→] ${preset.setups.map((choice) => choice.label).join(' / ')}`) : null}
          <Box marginTop={1}>
            {label('Scopes', 'scopes')}
            {input('scopes', preset?.custom ? 'space-separated' : 'space-separated — empty = the provider\'s default')}
          </Box>
          <Box marginTop={1}>
            {label('Client id', 'clientId')}
            {input('clientId', 'from the provider\'s console')}
          </Box>
          {preset?.clientAuth === 'none' ? null : (
            <Box marginTop={1}>
              {label('Client secret', 'clientSecret')}
              {input('clientSecret', exists
                ? 'leave empty to keep the stored one — never shown back'
                : 'from the provider\'s console — stored encrypted, never shown back', '•')}
            </Box>
          )}
          {preset?.custom ? (
            <>
              <Box marginTop={1}>
                {label('Auth URL', 'authUrl')}
                {input('authUrl', 'https://… the authorization endpoint')}
              </Box>
              <Box marginTop={1}>
                {label('Token URL', 'tokenUrl')}
                {input('tokenUrl', 'https://… the token endpoint')}
              </Box>
            </>
          ) : null}
        </>
      ) : (
        <Box marginTop={1}>
          {label('Value', 'value')}
          {input('value', exists
            ? 'leave empty to keep the stored value — never shown back'
            : 'the secret itself — stored encrypted, never shown back', '•')}
        </Box>
      )}
      {targets.length > 1 && pickRow('where', whereLabel, draft.projectId !== null, fixed ? 'fixed once connected' : `[space/←→] next of ${targets.length}`)}
      {oauth ? (
        <Box marginTop={1}>
          {label('Connect', 'connect')}
          {connecting ? <Text color="yellow">waiting for your browser… · [esc] cancels</Text>
            : connectError ? <Text color="red" wrap="truncate">{connectError} · [enter] retries</Text>
            : <Text color={state?.status === 'connected' ? 'green' : undefined} dimColor={!state || state.status === 'disconnected'}>
                {connection(state)}{focused === 'connect' ? ` · [enter] ${state?.status === 'connected' ? 'reconnects' : 'opens your browser'}` : ''}
              </Text>}
        </Box>
      ) : null}
      <Box marginTop={1}>
        {error
          ? <Text color="red" wrap="truncate">{error}</Text>
          : hint ? <Text dimColor wrap="truncate">{hint}</Text>
          : <Text dimColor>[tab/↑↓] move · [enter] next · [esc] close</Text>}
      </Box>
    </Box>
  );
}
