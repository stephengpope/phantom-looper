// Adding a project without leaving the app. Two shapes, because they are
// genuinely different acts: point at a repository that exists, or create one on
// GitHub and seed its base branch.
//
// An existing repo is PICKED, not typed: the server lists what the stored
// GitHub token can see (GET /github/repos — owned, shared, through an org;
// newest push first) and the list filters as you type, the /settings model combobox's
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
import { Box } from 'ink';
import { useInput } from './useInput.js';
import { FixedText, Text } from './Text.js';
import { useEffect, useState } from 'react';
import { TextInput } from './TextInput.js';
import { SelectList, type Choice } from './SelectList.js';
import { Screen } from './Screen.js';
import { ago } from './Launcher.js';
import type { Api } from './Settings.js';

export interface NewProjectRequest {
  url: string; create?: boolean; private?: boolean; display_name?: string;
}

/** One row of GET /github/repos. */
export interface GitHubRepo {
  owner: string; name: string; private: boolean; defaultBranch: string;
  pushedAt: string | null;
  /** A project already points at it. */
  added: boolean;
}

type Step =
  | { at: 'source' }
  | { at: 'pick' }
  | { at: 'url'; create: boolean }
  | { at: 'visibility'; url: string }
  | { at: 'working'; what: string; back: 'pick' | 'url' };

// A row of the picker: a listed repo, or whatever was typed.
type Pick = { repo: GitHubRepo } | { typed: string };

export function NewProject({ api, onSubmit, onCancel, error, now }: {
  api: Api;
  onSubmit: (req: NewProjectRequest) => void;
  onCancel: () => void;
  /** Whatever the server said last time, shown so it can be corrected. */
  error?: string;
  now?: number;
}) {
  const [step, setStep] = useState<Step>({ at: 'source' });
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  // null = not fetched yet; the list is fetched once per form and kept, so
  // a rejected submit hands the same list back without a second round trip.
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [notice, setNotice] = useState<string | undefined>();

  useInput((_char, key) => { if (key.escape) onCancel(); },
    { isActive: step.at === 'url' });

  // A rejected submit must hand the form back. The window does not remount
  // this component (re-showing the screen would lose what was typed): the
  // server's error is the signal, and it drops the form out of 'working' to
  // the step it came from with the typed value kept for correction. Without
  // this, every rejection left the form dead on the spinner.
  useEffect(() => {
    if (error) {
      setStep((step) => step.at === 'working'
        ? (step.back === 'pick' ? { at: 'pick' } : { at: 'url', create: false })
        : step);
    }
  }, [error]);

  // The list, fetched on entering the picker. A failure is not a dead end:
  // the URL field is the old way in, and the notice says why you are there.
  useEffect(() => {
    if (step.at !== 'pick' || repos !== null) return;
    let live = true;
    api('GET', '/github/repos')
      .then((repos) => { if (live) setRepos(repos as unknown as GitHubRepo[]); })
      .catch((error: Error & { code?: string }) => {
        if (!live) return;
        setNotice(error.code === 'not_set'
          ? 'no GitHub token in /keys — type the repo instead'
          : `could not list your repos (${error.message}) — type it instead`);
        setStep({ at: 'url', create: false });
      });
    return () => { live = false; };
  }, [step.at, repos, api]);

  const submitExisting = (what: string, back: 'pick' | 'url') => {
    setNotice(undefined);
    setStep({ at: 'working', what, back });
    onSubmit({ url: what });
  };

  if (step.at === 'source') {
    return (
      <Screen title="add a project" error={error}
        footer={[{ key: 'enter', does: 'choose' }, { key: 'esc', does: 'back' }]}>
        <SelectList
          choices={[
            { value: 'existing', label: 'an existing repo', detail: 'you already have it on GitHub',
              hint: 'Nothing is created — phantom-looper clones it.' },
            { value: 'create', label: 'a new repo', detail: 'create it on GitHub now',
              hint: 'Created with an initial commit. Fails if the name is taken.' },
          ]}
          onSelect={(pick) => setStep(pick === 'create' ? { at: 'url', create: true } : { at: 'pick' })}
          onCancel={onCancel}
        />
      </Screen>
    );
  }

  if (step.at === 'pick') {
    if (repos === null) return <Screen title="add a project" busy error={error} />;

    const needle = query.trim().toLowerCase();
    const shown = needle ? repos.filter((repo) => `${repo.owner}/${repo.name}`.toLowerCase().includes(needle)) : repos;
    const choices: Choice<Pick>[] = shown.map((repo) => ({
      value: { repo },
      label: `${repo.owner}/${repo.name}`,
      columns: [
        { text: repo.private ? 'private' : 'public', width: 9 },
        { text: repo.added ? 'already a project' : repo.pushedAt ? `pushed ${ago(repo.pushedAt, now)}` : '' },
      ],
      hint: repo.added ? 'This repo is a project here already.' : `Clones ${repo.owner}/${repo.name}; work starts from ${repo.defaultBranch}.`,
    }));
    // Whatever was typed, unless it names a listed repo exactly — the way in
    // for a repo the token cannot see.
    const typed = query.trim();
    if (typed && !repos.some((repo) => `${repo.owner}/${repo.name}`.toLowerCase() === typed.toLowerCase())) {
      choices.push({ value: { typed }, label: `add “${typed}”`,
        hint: 'A URL or owner/name the token may not list — the server checks it.' });
    }
    return (
      <Screen title="add a project" error={error} notice={notice}
        sub={repos.length ? 'the repos your GitHub token can see, newest push first' : 'your GitHub token sees no repos — type one'}
        footer={[
          { key: 'type', does: 'filter' }, { key: '↑↓', does: 'move' },
          { key: 'enter', does: 'add highlighted' }, { key: 'esc', does: 'back' },
        ]}>
        <Box marginBottom={1}>
          <FixedText color="cyan">{'  > '}</FixedText>
          <TextInput value={query} onChange={setQuery} placeholder="filter, or type owner/name…" />
        </Box>
        <SelectList
          key={query}
          choices={choices}
          reserve={2}
          onSelect={(pick) => {
            if ('typed' in pick) { submitExisting(pick.typed, 'pick'); return; }
            if (pick.repo.added) { setNotice(`${pick.repo.owner}/${pick.repo.name} is already a project here`); return; }
            submitExisting(`${pick.repo.owner}/${pick.repo.name}`, 'pick');
          }}
          onCancel={() => { setNotice(undefined); setStep({ at: 'source' }); }}
        />
      </Screen>
    );
  }

  if (step.at === 'url') {
    return (
      <Screen title="add a project" error={error} notice={notice}
        sub={step.create
          ? 'a name creates it under your account · org/name for an org'
          : 'the repo to add — its URL or owner/name'}
        footer={[
          { key: 'enter', does: step.create ? 'continue' : 'add' },
          { key: 'esc', does: 'back' },
        ]}>
        <Box>
          <FixedText color="cyan">{'  > '}</FixedText>
          <TextInput
            value={url} onChange={setUrl}
            placeholder={step.create ? 'my-project' : 'https://github.com/owner/name'}
            onSubmit={(value) => {
              const clean = value.trim();
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
      <Screen title="add a project" error={error}
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
    <Screen title="add a project" error={error} busy>
      <Text dimColor>{`  ${step.what}`}</Text>
    </Screen>
  );
}
