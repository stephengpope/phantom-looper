// The secrets the server holds for the coding agent — tokens the AGENT uses
// in the work (service API keys, deploy tokens), as opposed to /keys, the
// credentials that power phantom-looper itself. Stored encrypted on the
// server's settings table (the `secret` namespace); the agent reads them
// through secret_list / secret_get.
//
// ONE list, EVERY layer, GROUPED: `‹ all ›` is the global group first, then
// one group per project, each under its heading — global is not a
// project, so it never sits inside one. ←→ narrow the list to one
// project's own rows, /resume's cycle, named in the title; [n] there
// starts the editor on that project. [enter] opens the SecretEditor on
// the row with every field live and auto-saving: a new value overwrites,
// an empty one keeps the stored value, a changed name or Where MOVES it
// (write at the new spot, then remove the old). [d] removes the row at its
// own layer.
//
// An OAuth secret (the editor's Type row) is the same row with a connection
// on it: the list shows its provider and status, [c] connects it — the
// browser round-trip (oauthConnect.ts: the server builds the URL and
// exchanges the code; this side opens the browser and catches the
// redirect) — the editor's Connect row does the same, [x] disconnects it.
import { useCallback, useEffect, useState } from 'react';
import { SelectList, type Choice } from './SelectList.js';
import { SecretEditor, type SecretDraft, type SecretId, type SecretTarget } from './SecretEditor.js';
import { Screen } from './Screen.js';
import { useInput } from './useInput.js';
import type { Api } from '../settings.js';
import { catchRedirect, openBrowser } from '../oauthConnect.js';
import { OAUTH_REDIRECT_URI, type OAuthPreset, type OAuthState } from '@phantom-agent-sdk/client';

const GLOBAL_TAG = 'global';

interface Row { name: string; description: string; scope: 'global' | 'project'; project?: string; oauth?: OAuthState }
type Presets = { presets: OAuthPreset[]; redirectUri: string };
interface Project { id: string; name: string; displayName?: string | null }

/** The row's list key: its layer and name — the two that make it one row. */
const keyOf = (project: string | null | undefined, name: string) => `${project ?? ''}|${name}`;
const scopeQuery = (project: string | null | undefined) =>
  project ? `?project=${encodeURIComponent(project)}` : '';

export function Secrets({ api, onClose }: { api: Api; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [presets, setPresets] = useState<Presets>({ presets: [], redirectUri: OAUTH_REDIRECT_URI });
  // ←→: one project's own rows, or null for every layer, grouped.
  const [filter, setFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; row: Row } | null>(null);
  // The row the list comes back to after the editor: the one opened, or the
  // one a save just made — a new secret lands under the cursor, not off it.
  const [last, setLast] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // The bare list is every layer; the projects call names the groups,
      // the ←→ ring and the editor's Where targets. One failure fails the
      // screen honestly.
      const [reply, projects, presets] = await Promise.all([
        api('GET', '/secrets') as Promise<{ secrets: Row[] }>,
        api('GET', '/projects') as Promise<Project[]>,
        api('GET', '/secrets/oauth/presets') as Promise<Presets>,
      ]);
      setProjects(projects);
      setPresets(presets);
      setRows(reply.secrets);
      setNotice(undefined);
    } catch (error) { setNotice(`could not load: ${(error as Error).message}`); setRows([]); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  /** What a layer is called: the project's display name (a project the
   *  list no longer knows reads as its id), or `global`. */
  const wsName = (id?: string | null) => {
    const project = id ? projects.find((project) => project.id === id) : undefined;
    return project ? (project.displayName || project.name) : id || GLOBAL_TAG;
  };
  const layerOf = (row: Row) => (row.scope === 'project' ? wsName(row.project) : GLOBAL_TAG);

  // /resume's ring: all, then each project in the server's order, wrapping.
  const cycle = (dir: 1 | -1) => {
    const ring: (string | null)[] = [null, ...projects.map((project) => project.id)];
    const at = ring.indexOf(filter);
    setFilter(ring[(Math.max(at, 0) + dir + ring.length) % ring.length] ?? null);
  };

  // The list re-reads after every act, failed or not — a move that wrote
  // and then could not remove has left a row the list must show.
  const run = (what: () => Promise<unknown>, after: string) => {
    setBusy(true);
    void what()
      .then((said) => after || String(said), (error: Error) => error.message)
      .then(async (said) => { await load(); setNotice(said); })
      .finally(() => setBusy(false));
  };

  /** PUT at one layer. No value / client secret = the server keeps the stored one. */
  const put = (draft: SecretDraft, value?: string) =>
    api('PUT', `/secrets/${encodeURIComponent(draft.name)}${scopeQuery(draft.projectId)}`,
      draft.type === 'oauth'
        ? { description: draft.description,
            oauth: { provider: draft.oauth.provider, clientId: draft.oauth.clientId, scopes: draft.oauth.scopes.split(/[\s,]+/).filter(Boolean),
              ...(draft.oauth.authUrl ? { authUrl: draft.oauth.authUrl } : {}), ...(draft.oauth.tokenUrl ? { tokenUrl: draft.oauth.tokenUrl } : {}) },
            ...(draft.oauth.clientSecret ? { clientSecret: draft.oauth.clientSecret } : {}) }
        : { description: draft.description, ...(value ? { value } : {}) });

  /** The browser round-trip for a stored OAuth secret: the server's URL in
   *  the browser, the redirect caught here, the server finishing it. */
  const connect = async (id: SecretId, signal: AbortSignal, onUrl: (url: string) => void = () => undefined): Promise<OAuthState> => {
    const path = `/secrets/${encodeURIComponent(id.name)}`;
    const { url } = await api('POST', `${path}/oauth/start${scopeQuery(id.projectId)}`) as { url: string };
    const caught = catchRedirect(presets.redirectUri, signal);
    openBrowser(url);
    onUrl(url);
    // The browser may not open (no desktop, ssh): the url is on screen to copy.
    setNotice(`${id.name}: finish in your browser — if it did not open, visit ${url}`);
    const { oauth } = await api('POST', `${path}/oauth/callback`, { url: await caught }) as { oauth: OAuthState };
    await load();
    return oauth;
  };

  /** [c] on a row: connect it from the list, no editor. */
  const connectRow = (row: Row) => {
    const controller = new AbortController();
    run(() => connect({ name: row.name, projectId: row.project ?? null }, controller.signal)
      .then((oauth) => `${row.name} connected${oauth.accountEmail ? ` · ${oauth.accountEmail}` : ''}`), '');
  };

  /** The editor's auto-save: one write, the editor stays open. Rejects so
   *  the editor can say why; the list re-reads either way. */
  const save = async (draft: SecretDraft, from?: SecretId) => {
    setLast(keyOf(draft.projectId, draft.name));
    const moved = from && (from.name !== draft.name || from.projectId !== draft.projectId);
    try {
      if (!moved) {
        await put(draft, draft.value || undefined);
        setNotice(`${draft.name} saved (${wsName(draft.projectId)})`);
        return;
      }
      // A move: the value goes with it — typed fresh, or read back from the
      // old spot (this process already holds every value the agent reads).
      // Write first, remove second: a failure in between leaves both rows
      // on the list, never neither. (The editor never moves an OAuth secret.)
      const oldPath = `/secrets/${encodeURIComponent(from.name)}${scopeQuery(from.projectId)}`;
      const value = draft.value || (await api('GET', oldPath) as { value: string }).value;
      await put(draft, value);
      await api('DELETE', oldPath);
      setNotice(`${from.name} (${wsName(from.projectId)}) moved to ${draft.name} (${wsName(draft.projectId)})`);
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    } finally { await load(); }
  };

  const shown = (rows ?? []).filter((row) => filter === null || row.project === filter);
  // ←→ are the list's neighbours, not its own keys (SelectList leaves them
  // alone), so this screen takes them — over the rows and the empty state alike.
  useInput((_ch, key) => {
    if (key.leftArrow) cycle(-1);
    else if (key.rightArrow) cycle(1);
  }, { isActive: editing === null && projects.length > 0 });

  if (editing) {
    const targets: SecretTarget[] = [
      { id: null, label: 'global — every project' },
      ...projects.map((project) => ({ id: project.id, label: `${project.displayName || project.name} only` })),
    ];
    return (
      <SecretEditor
        mode={editing.mode}
        initial={editing.mode === 'edit'
          ? { name: editing.row.name, description: editing.row.description, projectId: editing.row.project ?? null, oauth: editing.row.oauth }
          : { projectId: filter }}
        targets={targets} presets={presets}
        onSave={save} onConnect={connect} onClose={() => setEditing(null)}
      />
    );
  }

  // ‹ all ›: one group per layer — global, then each project that has
  // rows — under a heading, each row tagged with its layer. One project:
  // its rows alone, no heading and no tag — the title already names it.
  const choice = (row: Row): Choice<string> => ({
    value: keyOf(row.project, row.name), label: row.name,
    ...(filter === null ? { detail: layerOf(row) } : {}),
    hint: (row.description || '(no description)') + (row.oauth ? ` · ${row.oauth.provider} · ${row.oauth.status}${row.oauth.accountEmail ? ` · ${row.oauth.accountEmail}` : ''}` : ''),
  });
  const choices: Choice<string>[] = [];
  if (filter === null) {
    const groups: Array<[string, Row[]]> = [
      [GLOBAL_TAG, shown.filter((row) => row.scope === 'global')],
      ...projects.map((project): [string, Row[]] => [wsName(project.id), shown.filter((row) => row.project === project.id)]),
    ];
    for (const [heading, members] of groups) {
      if (!members.length) continue;
      choices.push({ value: `#${heading}`, label: heading, heading: true });
      choices.push(...members.map(choice));
    }
  } else {
    choices.push(...shown.map(choice));
  }

  const where = filter === null ? 'all' : wsName(filter);
  return (
    <Screen title={projects.length ? `secrets · ‹ ${where} ›` : 'secrets'}
      sub="for the coding agent · global, then each project's own"
      busy={busy} notice={notice ?? (shown.length === 0
        ? (filter === null ? 'no secrets yet — [n] adds one' : `no secrets of ${where}'s own — [n] adds one, ‹ all › shows the global ones`)
        : undefined)}
      footer={[
        { key: '←→', does: 'project', when: projects.length > 0 },
        { key: 'enter', does: 'edit' }, { key: 'n', does: 'new secret' },
        { key: 'c', does: 'connect', when: shown.some((row) => row.oauth) },
        { key: 'x', does: 'disconnect', when: shown.some((row) => row.oauth?.status === 'connected') },
        { key: 'd', does: 'remove' }, { key: 'esc', does: 'close' },
      ]}>
      <SelectList
        choices={choices}
        initial={last}
        onSelect={(value) => {
          setLast(value);
          const row = shown.find((row) => keyOf(row.project, row.name) === value);
          if (row) setEditing({ mode: 'edit', row });
        }}
        onCancel={onClose}
        onKey={(char, value) => {
          if (char === 'n') { setEditing({ mode: 'new' }); return; }
          if (!['d', 'x', 'c'].includes(char) || !value) return;
          const row = shown.find((row) => keyOf(row.project, row.name) === value);
          if (!row) return;
          if (char === 'c') { if (row.oauth) connectRow(row); return; }
          if (char === 'x') {
            if (!row.oauth || row.oauth.status === 'disconnected') return;
            run(() => api('POST', `/secrets/${encodeURIComponent(row.name)}/oauth/disconnect${scopeQuery(row.project)}`),
              `${row.name} disconnected — [enter] to connect it again`);
            return;
          }
          run(() => api('DELETE', `/secrets/${encodeURIComponent(row.name)}${scopeQuery(row.project)}`),
            `${row.name} removed (${layerOf(row)})`);
        }}
      />
    </Screen>
  );
}
