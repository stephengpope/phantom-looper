// `phantom-cli setup-backend` — the screens. The DRIVER (setup.tsx) renders
// each of these standalone, pre-App, the way index.tsx already renders
// Launcher and NewWorkspace at startup: one screen, one answer, unmount.
// Provisioning itself happens BETWEEN screens, outside Ink entirely, because
// ssh must own the tty for its password and host-key prompts and the
// installer's output is worth watching as it streams.
//
// Two questions is the whole promise of this flow: where the server goes, and
// one model credential. Everything else is a default the installer applies.
// Pairing with a server that already exists is /server, inside the app.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { useState } from 'react';
import { TextInput } from './TextInput.js';
import { SelectList } from './SelectList.js';
import { Screen } from './Screen.js';
import { PROVIDERS, PROVIDER_KEY } from '../config.js';

/** user@host for the new server. */
export function SetupTarget({ onSubmit, onCancel, error }: {
  onSubmit: (target: string) => void;
  onCancel: () => void;
  error?: string;
}) {
  const [value, setValue] = useState('');
  useInput((_c, key) => { if (key.escape) onCancel(); });
  return (
    <Screen title="phantom-looper · set up a server" error={error}
      sub="a fresh Ubuntu/Debian box you can SSH into — root recommended · user@host or user@host:port"
      footer={[{ key: 'enter', does: 'install' }, { key: 'esc', does: 'quit' }]}>
      <Box>
        <Text color="cyan">{'  > '}</Text>
        <TextInput
          value={value} onChange={setValue}
          placeholder="root@203.0.113.7"
          onSubmit={(v) => { if (v.trim()) onSubmit(v.trim()); }}
        />
      </Box>
    </Screen>
  );
}

export interface ProviderKeyAnswer { settingKey: string; value: string; provider: string }

/** One model credential, pushed to the server's /keys store — the same row
 *  /keys edits later. Skippable: the app runs, and the first turn's error
 *  points at /keys. */
export function SetupProviderKey({ onSubmit, onSkip, error }: {
  onSubmit: (v: ProviderKeyAnswer) => void;
  onSkip: () => void;
  error?: string;
}) {
  const [provider, setProvider] = useState<string | null>(null);
  const [key, setKey] = useState('');
  useInput((_c, k) => { if (k.escape && provider) setProvider(null); },
    { isActive: provider !== null });
  if (provider === null) {
    return (
      <Screen title="model access" error={error}
        sub="one credential, stored encrypted on the server — every window and agent uses it"
        footer={[{ key: 'enter', does: 'choose' }, { key: 'esc', does: 'skip' }]}>
        <SelectList
          choices={[
            { value: 'anthropic', label: 'anthropic', detail: 'API key or Claude subscription token' },
            ...PROVIDERS.filter((p) => p !== 'anthropic').map((p) => ({ value: p as string, label: p })),
            { value: '', label: 'skip for now', hint: 'Paste one later on /keys.' },
          ]}
          onSelect={(v) => (v === '' ? onSkip() : setProvider(v))}
          onCancel={onSkip}
        />
      </Screen>
    );
  }
  return (
    <Screen title="model access" error={error}
      sub={`${provider} — paste the key (input is masked)`}
      footer={[{ key: 'enter', does: 'save' }, { key: 'esc', does: 'back' }]}>
      <Box>
        <Text color="cyan">{'  > '}</Text>
        <TextInput value={key} onChange={setKey} mask="•"
          onSubmit={(v) => {
            const clean = v.trim();
            if (!clean) return;
            onSubmit({ settingKey: PROVIDER_KEY[provider as keyof typeof PROVIDER_KEY], value: clean, provider });
          }} />
      </Box>
    </Screen>
  );
}
