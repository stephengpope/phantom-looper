// Adding a workspace without leaving the app. Two shapes, because they are
// genuinely different acts: point at a repository that exists, or create one on
// GitHub and seed its base branch.
//
// An existing repo is PICKED, not typed: the server lists what the stored
// GitHub token can see (GET /github/repos — owned, shared, through an org;
// newest push first) and the list filters as you type, the /model combobox's
// shape. Anything typed that is not in the list is offered as its own row, so
// a repo the token cannot see is still one field away. No token (or GitHub
// unreachable) falls back to the plain URL field with the reason on screen.
//
// No token field: creation falls back to the global `github_token`, which is
// where credentials belong. If it is missing the server says so precisely, and
// that message is worth more than a prompt that guesses.
//
// Each step renders Screen directly. A local Frame component defined inside
// the render was a new component type on every render, so React remounted the
// whole step per keystroke — TextInput's cursor-at-end behaviour hid it.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { useEffect, useState } from 'react';
import { TextInput } from './TextInput.js';
import { SelectList, type Choice } from './SelectList.js';
import { Screen } from './Screen.js';
import { ago } from './Launcher.js';
import type { Api } from './Settings.js';

export interface NewWorkspaceRequest {
  url: string; create?: boolean; private?: boolean; display_name?: string;
}

/** One row of GET /github/repos. */
export interface GitHubRepo {
  owner: string; name: string; private: boolean; defaultBranch: string;
  pushedAt: string | null;
  /** A workspace already points at it. */
  added: boolean;
}

type Step =
  | { at: 'kind' }
  | { at: 'pick' }
  | { at: 'url'; create: boolean }
  | { at: 'visibility'; url: string }
  | { at: 'working'; what: string; back: 'pick' | 'url' };

// A row of the picker: a listed repo, or whatever was typed.
type Pick = { repo: GitHubRepo } | { typed: string };

export function NewWorkspace({ api, onSubmit, onCancel, error, now }: {
  api: Api;
  onSubmit: (req: NewWorkspaceRequest) => void;
  onCancel: () => void;
  /** Whatever the server said last time, shown so it can be corrected. */
  error?: string;
  now?: number;
}) {
  const [step, setStep] = useState<Step>({ at: 'kind' });
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  // null = not fetched yet; the list is fetched once per form and kept, so
  // a rejected submit hands the same list back without a second round trip.
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [notice, setNotice] = useState<string | undefined>();

  useInput((_c, key) => { if (key.escape) onCancel(); },
    { isActive: step.at === 'url' });

  // A rejected submit must hand the form back. App cannot remount this
  // component (the menu is already 'addWorkspace', so setMenu is a no-op):
  // the server's error is the signal, and it drops the form out of
  // 'working' to the step it came from with the typed value kept for
  // correction. Without this, every rejection left the form dead on the spinner.
  useEffect(() => {
    if (error) {
      setStep((s) => s.at === 'working'
        ? (s.back === 'pick' ? { at: 'pick' } : { at: 'url', create: false })
        : s);
    }
  }, [error]);

  // The list, fetched on entering the picker. A failure is not a dead end:
  // the URL field is the old way in, and the notice says why you are there.
  useEffect(() => {
    if (step.at !== 'pick' || repos !== null) return;
    let live = true;
    api('GET', '/github/repos')
      .then((r) => { if (live) setRepos(r as unknown as GitHubRepo[]); })
      .catch((e: Error & { code?: string }) => {
        if (!live) return;
        setNotice(e.code === 'not_set'
          ? 'no GitHub token in /keys — type the repo instead'
          : `could not list your repos (${e.message}) — type it instead`);
        setStep({ at: 'url', create: false });
      });
    return () => { live = false; };
  }, [step.at, repos, api]);

  const submitExisting = (what: string, back: 'pick' | 'url') => {
    setNotice(undefined);
    setStep({ at: 'working', what, back });
    onSubmit({ url: what });
  };

  if (step.at === 'kind') {
    return (
      <Screen title="add a workspace" error={error}
        footer={[{ key: 'enter', does: 'choose' }, { key: 'esc', does: 'back' }]}>
        <SelectList
          choices={[
            { value: 'existing', label: 'an existing repo', detail: 'you already have it on GitHub',
              hint: 'Nothing is created — phantom-looper clones it.' },
            { value: 'create', label: 'a new repo', detail: 'create it on GitHub now',
              hint: 'Created with an initial commit. Fails if the name is taken.' },
          ]}
          onSelect={(v) => setStep(v === 'create' ? { at: 'url', create: true } : { at: 'pick' })}
          onCancel={onCancel}
        />
      </Screen>
    );
  }

  if (step.at === 'pick') {
    if (repos === null) return <Screen title="add a workspace" busy error={error} />;

    const q = query.trim().toLowerCase();
    const shown = q ? repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q)) : repos;
    const choices: Choice<Pick>[] = shown.map((r) => ({
      value: { repo: r },
      label: `${r.owner}/${r.name}`,
      columns: [
        { text: r.private ? 'private' : 'public', width: 9 },
        { text: r.added ? 'already a workspace' : r.pushedAt ? `pushed ${ago(r.pushedAt, now)}` : '' },
      ],
      hint: r.added ? 'This repo is a workspace here already.' : `Clones ${r.owner}/${r.name}; work starts from ${r.defaultBranch}.`,
    }));
    // Whatever was typed, unless it names a listed repo exactly — the way in
    // for a repo the token cannot see.
    const typed = query.trim();
    if (typed && !repos.some((r) => `${r.owner}/${r.name}`.toLowerCase() === typed.toLowerCase())) {
      choices.push({ value: { typed }, label: `add “${typed}”`,
        hint: 'A URL or owner/name the token may not list — the server checks it.' });
    }
    return (
      <Screen title="add a workspace" error={error} notice={notice}
        sub={repos.length ? 'the repos your GitHub token can see, newest push first' : 'your GitHub token sees no repos — type one'}
        footer={[
          { key: 'type', does: 'filter' }, { key: '↑↓', does: 'move' },
          { key: 'enter', does: 'add highlighted' }, { key: 'esc', does: 'back' },
        ]}>
        <Box marginBottom={1}>
          <Text color="cyan">{'  > '}</Text>
          <TextInput value={query} onChange={setQuery} placeholder="filter, or type owner/name…" />
        </Box>
        <SelectList
          key={query}
          choices={choices}
          reserve={2}
          pad
          onSelect={(p) => {
            if ('typed' in p) { submitExisting(p.typed, 'pick'); return; }
            if (p.repo.added) { setNotice(`${p.repo.owner}/${p.repo.name} is already a workspace here`); return; }
            submitExisting(`${p.repo.owner}/${p.repo.name}`, 'pick');
          }}
          onCancel={() => { setNotice(undefined); setStep({ at: 'kind' }); }}
        />
      </Screen>
    );
  }

  if (step.at === 'url') {
    return (
      <Screen title="add a workspace" error={error} notice={notice}
        sub={step.create
          ? 'a name creates it under your account · org/name for an org'
          : 'the repo to add — its URL or owner/name'}
        footer={[
          { key: 'enter', does: step.create ? 'continue' : 'add' },
          { key: 'esc', does: 'back' },
        ]}>
        <Box>
          <Text color="cyan">{'  > '}</Text>
          <TextInput
            value={url} onChange={setUrl}
            placeholder={step.create ? 'my-project' : 'https://github.com/owner/name'}
            onSubmit={(v) => {
              const clean = v.trim();
              if (!clean) return;
              if (step.create) setStep({ at: 'visibility', url: clean });
              else submitExisting(clean, 'url');
            }}
          />
        </Box>
      </Screen>
    );
  }

  if (step.at === 'visibility') {
    return (
      <Screen title="add a workspace" error={error}
        footer={[{ key: 'enter', does: 'create' }, { key: 'esc', does: 'back' }]}>
        <Text dimColor>{`  ${step.url}`}</Text>
        <SelectList
          reserve={1}
          choices={[
            { value: true, label: 'private', detail: 'recommended' },
            { value: false, label: 'public' },
          ]}
          onSelect={(isPrivate) => {
            setStep({ at: 'working', what: step.url, back: 'url' });
            onSubmit({ url: step.url, create: true, private: isPrivate });
          }}
          onCancel={() => setStep({ at: 'url', create: true })}
        />
      </Screen>
    );
  }

  return (
    <Screen title="add a workspace" error={error} busy>
      <Text dimColor>{`  ${step.what}`}</Text>
    </Screen>
  );
}
