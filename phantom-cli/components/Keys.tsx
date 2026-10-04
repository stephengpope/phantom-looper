// The credentials the server holds — ONE place to set any of them, and one key
// per provider so a key pasted here works for the commit-message writer, this
// cli's coding agent and the Assistant alike.
//
// They are settings — same table, same layers, same routes — stored encrypted,
// and the screen masks them because a terminal has scrollback. Which
// credentials exist, what to call them, how they group and what each is for
// all come from GET /settings (the entries flagged `secret`): the server is
// the one place a credential is described, and this screen shows it verbatim.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SelectList } from './SelectList.js';
import { ValueInput } from './ValueInput.js';
import { Screen } from './Screen.js';
import { makeSettings, type Api, type Entry } from '../settings.js';
import { labelFor } from '../settingLabels.js';
import { groupBlocks, headedChoices } from '../settingGroups.js';

/** The credential rows under the server's group headings, in its order. */
const groupedChoices = (creds: Array<[string, Entry]>) =>
  headedChoices(groupBlocks(creds, ([, entry]) => entry.meta), ([name, entry]) => {
    const stored = typeof entry.value === 'string' && entry.value.length > 0;
    return { value: name, label: labelFor(name, entry.meta), detail: stored ? 'stored' : 'not set', hint: entry.description };
  });

export function Keys({ api, onClose, onChanged }: {
  api: Api; onClose: () => void;
  /** Fired after a key is saved or removed. These ARE settings, so a change has
   *  to reach the app the same way any other one does — the Assistant reads its
   *  Deepgram key at spawn, so without this you could save the key, watch the
   *  screen say it was stored, and still have voice fail with "needs a deepgram
   *  key" until you restarted the cli. */
  onChanged?: (name: string) => void;
}) {
  const settings = useMemo(() => makeSettings(api), [api]);
  const [creds, setCreds] = useState<Array<[string, Entry]> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // The key last opened, so the list comes back with the cursor on it.
  const [last, setLast] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // One read of the server's store; a credential comes back with its
      // value, and the screen masks it rather than the API hiding it.
      const all = await settings.all();
      setCreds(Object.entries(all).filter(([, entry]) => entry.secret));
      setNotice(undefined);
    } catch (entry) { setNotice(`could not load: ${(entry as Error).message}`); setCreds([]); }
    finally { setBusy(false); }
  }, [settings]);

  useEffect(() => { void load(); }, [load]);

  const run = (what: () => Promise<unknown>, after?: string | (() => Promise<string>), changed?: string) => {
    setBusy(true);
    void what()
      .then(async () => { await load(); setNotice(typeof after === 'function' ? await after() : after); if (changed) onChanged?.(changed); })
      .catch((error: Error) => setNotice(error.message))
      .finally(() => { setBusy(false); setEditing(null); });
  };

  /** A github token is checked the moment it is saved — the server asks GitHub
   *  whose it is — so a mistyped or expired one is caught HERE, where the fix
   *  is, instead of at the next clone. The save stands either way: the check
   *  only names the outcome. */
  const checkGithub = async (): Promise<string> => {
    try {
      const whoami = await api('GET', '/github/whoami') as { login?: string };
      return `github token saved — works, authenticated as ${String(whoami?.login ?? 'unknown')}`;
    } catch (entry) {
      return `github token saved, but it does not work: ${(entry as Error).message}`;
    }
  };

  const stored = new Set((creds ?? []).filter(([, entry]) => typeof entry.value === 'string' && entry.value.length > 0).map(([name]) => name));

  if (editing) {
    const label = labelFor(editing, creds?.find(([name]) => name === editing)?.[1].meta);
    return (
      <ValueInput
        spec={{ title: label, type: 'string', secret: true, current: '',
          note: 'stored encrypted on the server · never shown back · empty cancels' }}
        onCancel={() => setEditing(null)}
        onSubmit={(value) => {
          if (value === null) { setEditing(null); return; }   // empty cancels rather than storing ""
          run(() => settings.patch({ [editing]: String(value) }),
            editing === 'github_token' ? checkGithub : `${label} saved`, editing);
        }}
      />
    );
  }

  return (
    <Screen title="keys"
      sub="stored on the server, used by every agent"
      busy={busy} notice={notice}
      footer={[
        { key: 'enter', does: 'set' }, { key: 'd', does: 'remove' },
        { key: 'esc', does: 'close' },
      ]}>
      <SelectList
        choices={groupedChoices(creds ?? [])}
        initial={last}
        onSelect={(name) => { setLast(name); setEditing(name); }}
        onCancel={onClose}
        onKey={(char, name) => {
          if (char !== 'd' || !name) return;
          if (!stored.has(name)) { setNotice('nothing stored there to remove'); return; }
          run(() => settings.clear(name), 'removed', name);
        }}
      />
    </Screen>
  );
}
