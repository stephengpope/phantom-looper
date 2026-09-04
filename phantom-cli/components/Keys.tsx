// The credentials the server holds — ONE place to set any of them, and one key
// per provider so a key pasted here works for the Git Fixer, this TUI's coding
// agent and the Assistant alike.
//
// They used to be "secrets": write-only, never shown back, on their own screen
// because settings were readable and these were not. They are settings now —
// same table, same layers, same routes — so the only thing special left about
// them is that they are stored encrypted, and the screen still masks them
// because a terminal has scrollback.
//
// Named the way each vendor names the thing: GitHub says token, everyone else
// says API key.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SelectList } from './SelectList.js';
import { ValueInput } from './ValueInput.js';
import { Screen } from './Screen.js';
import { makeSettings, type Api } from '../settings.js';

const NAMES = [
  { name: 'github_token', label: 'github token',
    hint: 'Used for clones, pushes and pull requests. A workspace with its own token ignores this one.' },
  { name: 'anthropic_api_key', label: 'anthropic key',
    hint: 'Used by every agent set to the anthropic provider.' },
  { name: 'openai_api_key', label: 'openai key', hint: 'Used by every agent set to the openai provider.' },
  { name: 'google_api_key', label: 'google key', hint: 'Used by every agent set to the google provider.' },
  { name: 'openai_compatible_api_key', label: 'openai-compatible key',
    hint: 'Used for an OpenAI-compatible endpoint: Ollama, vLLM, OpenRouter.' },
  { name: 'deepgram_api_key', label: 'deepgram key',
    hint: 'Speech to text and text to speech for the Assistant. Without it the Assistant has no voice.' },
  { name: 'firecrawl_api_key', label: 'firecrawl key',
    hint: 'Used by the web_search and web_fetch tools (firecrawl.dev). Without it web calls fail.' },
  { name: 'telegram_bot_token', label: 'telegram bot token',
    hint: 'From @BotFather. With telegram enabled and an authorized user set (/settings), saving it registers the webhook.' },
] as const;

export function Keys({ api, onClose, onChanged }: {
  api: Api; onClose: () => void;
  /** Fired after a key is saved or removed. These ARE settings, so a change has
   *  to reach the app the same way any other one does — the Assistant reads its
   *  Deepgram key at spawn, so without this you could save the key, watch the
   *  screen say it was stored, and still have voice fail with "needs a deepgram
   *  key" until you restarted the TUI. */
  onChanged?: (name: string) => void;
}) {
  const settings = useMemo(() => makeSettings(api), [api]);
  const [set, setSet] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // The key last opened, so the list comes back with the cursor on it.
  const [last, setLast] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // One read of the server's namespace; a credential comes back with its
      // value, and the screen masks it rather than the API hiding it.
      const all = await settings.all();
      setSet(NAMES.map((n) => n.name).filter((n) => {
        const v = all?.[n]?.value;
        return typeof v === 'string' && v.length > 0;
      }));
      setNotice(undefined);
    } catch (e) { setNotice(`could not load: ${(e as Error).message}`); setSet([]); }
    finally { setBusy(false); }
  }, [settings]);

  useEffect(() => { void load(); }, [load]);

  const run = (what: () => Promise<unknown>, after?: string | (() => Promise<string>), changed?: string) => {
    setBusy(true);
    void what()
      .then(async () => { await load(); setNotice(typeof after === 'function' ? await after() : after); if (changed) onChanged?.(changed); })
      .catch((e: Error) => setNotice(e.message))
      .finally(() => { setBusy(false); setEditing(null); });
  };

  /** A github token is checked the moment it is saved — the server asks GitHub
   *  whose it is — so a mistyped or expired one is caught HERE, where the fix
   *  is, instead of at the next clone. The save stands either way: the check
   *  only names the outcome. */
  const checkGithub = async (): Promise<string> => {
    try {
      const r = await api('GET', '/github/whoami') as { login?: string };
      return `github token saved — works, authenticated as ${String(r?.login ?? 'unknown')}`;
    } catch (e) {
      return `github token saved, but it does not work: ${(e as Error).message}`;
    }
  };

  if (editing) {
    const row = NAMES.find((n) => n.name === editing)!;
    return (
      <ValueInput
        spec={{ title: row.label, type: 'string', secret: true, current: '',
          note: 'stored encrypted on the server · never shown back · empty cancels' }}
        onCancel={() => setEditing(null)}
        onSubmit={(v) => {
          if (v === null) { setEditing(null); return; }   // empty cancels rather than storing ""
          run(() => settings.patch({ [editing]: String(v) }),
            editing === 'github_token' ? checkGithub : `${row.label} saved`, editing);
        }}
      />
    );
  }

  const stored = new Set(set ?? []);
  return (
    <Screen title="keys"
      sub="stored on the server, used by every agent"
      busy={busy} notice={notice}
      footer={[
        { key: 'enter', does: 'set' }, { key: 'd', does: 'remove' },
        { key: 'esc', does: 'close' },
      ]}>
      <SelectList
        choices={NAMES.map((n) => ({
          value: n.name,
          label: n.label,
          detail: stored.has(n.name) ? 'stored' : 'not set',
          hint: n.hint,
        }))}
        initial={last}
        onSelect={(n) => { setLast(n); setEditing(n); }}
        onCancel={onClose}
        onKey={(ch, n) => {
          if (ch !== 'd' || !n) return;
          if (!stored.has(n)) { setNotice('nothing stored there to remove'); return; }
          run(() => settings.clear(n), 'removed', n);
        }}
      />
    </Screen>
  );
}
