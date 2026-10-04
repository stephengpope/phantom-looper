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
import { useCallback, useEffect, useState } from 'react';
import { SelectList, type Choice } from './SelectList.js';
import { SecretEditor, type SecretDraft, type SecretId, type SecretTarget } from './SecretEditor.js';
import { Screen } from './Screen.js';
import { useInput } from './useInput.js';
import type { Api } from '../settings.js';

const GLOBAL_TAG = 'global';

interface Row { name: string; description: string; scope: 'global' | 'project'; project?: string }
interface Project { id: string; name: string; displayName?: string | null }

/** The row's list key: its layer and name — the two that make it one row. */
const keyOf = (project: string | null | undefined, name: string) => `${project ?? ''}|${name}`;
const scopeQuery = (project: string | null | undefined) =>
  project ? `?project=${encodeURIComponent(project)}` : '';

export function Secrets({ api, onClose }: { api: Api; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
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
      const [reply, projects] = await Promise.all([
        api('GET', '/secrets') as Promise<{ secrets: Row[] }>,
        api('GET', '/projects') as Promise<Project[]>,
      ]);
      setProjects(projects);
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
      .then(() => after, (error: Error) => error.message)
      .then(async (said) => { await load(); setNotice(said); })
      .finally(() => setBusy(false));
  };

  /** PUT at one layer. No value = the server keeps the stored one. */
  const put = (draft: SecretDraft, value?: string) =>
    api('PUT', `/secrets/${encodeURIComponent(draft.name)}${scopeQuery(draft.projectId)}`,
      { description: draft.description, ...(value ? { value } : {}) });

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
      // on the list, never neither.
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
          ? { name: editing.row.name, description: editing.row.description, projectId: editing.row.project ?? null }
          : { projectId: filter }}
        targets={targets}
        onSave={save} onClose={() => setEditing(null)}
      />
    );
  }

  // ‹ all ›: one group per layer — global, then each project that has
  // rows — under a heading, each row tagged with its layer. One project:
  // its rows alone, no heading and no tag — the title already names it.
  const choice = (row: Row): Choice<string> => ({
    value: keyOf(row.project, row.name), label: row.name,
    ...(filter === null ? { detail: layerOf(row) } : {}),
    hint: row.description || '(no description)',
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
          if (char !== 'd' || !value) return;
          const row = shown.find((row) => keyOf(row.project, row.name) === value);
          if (!row) return;
          run(() => api('DELETE', `/secrets/${encodeURIComponent(row.name)}${scopeQuery(row.project)}`),
            `${row.name} removed (${layerOf(row)})`);
        }}
      />
    </Screen>
  );
}
