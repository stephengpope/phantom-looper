// The secrets the server holds for the coding agent — tokens the AGENT uses
// in the work (service API keys, deploy tokens), as opposed to /keys, the
// credentials that power phantom-looper itself. Stored encrypted on the
// server's settings table (the `secret` namespace); the agent reads them
// through secret_list / secret_get.
//
// ONE list, EVERY layer, GROUPED: `‹ all ›` is the global group first, then
// one group per workspace, each under its heading — global is not a
// workspace, so it never sits inside one. ←→ narrow the list to one
// workspace's own rows, /resume's cycle, named in the title; [n] there
// starts the editor on that workspace. [enter] opens the SecretEditor on
// the row with every field live: a new value overwrites, an empty one keeps
// the stored value, a changed name or Where MOVES it (write at the new
// spot, then remove the old). [d] removes the row at its own layer.
import { useCallback, useEffect, useState } from 'react';
import { SelectList, type Choice } from './SelectList.js';
import { SecretEditor, type SecretDraft, type SecretTarget } from './SecretEditor.js';
import { Screen } from './Screen.js';
import { useInput } from './useInput.js';
import type { Api } from '../settings.js';

const GLOBAL_TAG = 'global';

interface Row { name: string; description: string; scope: 'global' | 'workspace'; workspace?: string }
interface Workspace { id: string; name: string; displayName?: string | null }

/** The row's list key: its layer and name — the two that make it one row. */
const keyOf = (workspace: string | null | undefined, name: string) => `${workspace ?? ''}|${name}`;
const scopeQuery = (workspace: string | null | undefined) =>
  workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';

export function Secrets({ api, onClose }: { api: Api; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // ←→: one workspace's own rows, or null for every layer, grouped.
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
      // The bare list is every layer; the workspaces call names the groups,
      // the ←→ ring and the editor's Where targets. One failure fails the
      // screen honestly.
      const [r, ws] = await Promise.all([
        api('GET', '/secrets') as Promise<{ secrets: Row[] }>,
        api('GET', '/workspaces') as Promise<Workspace[]>,
      ]);
      setWorkspaces(ws);
      setRows(r.secrets);
      setNotice(undefined);
    } catch (e) { setNotice(`could not load: ${(e as Error).message}`); setRows([]); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  /** What a layer is called: the workspace's display name (a workspace the
   *  list no longer knows reads as its id), or `global`. */
  const wsName = (id?: string | null) => {
    const w = id ? workspaces.find((x) => x.id === id) : undefined;
    return w ? (w.displayName || w.name) : id || GLOBAL_TAG;
  };
  const layerOf = (r: Row) => (r.scope === 'workspace' ? wsName(r.workspace) : GLOBAL_TAG);

  // /resume's ring: all, then each workspace in the server's order, wrapping.
  const cycle = (dir: 1 | -1) => {
    const ring: (string | null)[] = [null, ...workspaces.map((w) => w.id)];
    const at = ring.indexOf(filter);
    setFilter(ring[(Math.max(at, 0) + dir + ring.length) % ring.length] ?? null);
  };

  // The list re-reads after every act, failed or not — a move that wrote
  // and then could not remove has left a row the list must show.
  const run = (what: () => Promise<unknown>, after: string) => {
    setBusy(true);
    void what()
      .then(() => after, (e: Error) => e.message)
      .then(async (said) => { await load(); setNotice(said); })
      .finally(() => { setBusy(false); setEditing(null); });
  };

  /** PUT at one layer. No value = the server keeps the stored one. */
  const put = (d: SecretDraft, value?: string) =>
    api('PUT', `/secrets/${encodeURIComponent(d.name)}${scopeQuery(d.workspaceId)}`,
      { description: d.description, ...(value ? { value } : {}) });

  const save = (d: SecretDraft) => {
    setLast(keyOf(d.workspaceId, d.name));
    const from = editing?.mode === 'edit' ? editing.row : undefined;
    const moved = from && (from.name !== d.name || (from.workspace ?? null) !== d.workspaceId);
    if (!moved) {
      run(() => put(d, d.value || undefined), `${d.name} saved (${wsName(d.workspaceId)})`);
      return;
    }
    // A move: the value goes with it — typed fresh, or read back from the
    // old spot (this process already holds every value the agent reads).
    // Write first, remove second: a failure in between leaves both rows
    // on the list, never neither.
    const oldPath = `/secrets/${encodeURIComponent(from.name)}${scopeQuery(from.workspace)}`;
    run(async () => {
      const value = d.value || (await api('GET', oldPath) as { value: string }).value;
      await put(d, value);
      await api('DELETE', oldPath);
    }, `${from.name} (${layerOf(from)}) moved to ${d.name} (${wsName(d.workspaceId)})`);
  };

  const shown = (rows ?? []).filter((r) => filter === null || r.workspace === filter);
  // ←→ are the list's neighbours, not its own keys (SelectList leaves them
  // alone), so this screen takes them — over the rows and the empty state alike.
  useInput((_ch, key) => {
    if (key.leftArrow) cycle(-1);
    else if (key.rightArrow) cycle(1);
  }, { isActive: editing === null && workspaces.length > 0 });

  if (editing) {
    const targets: SecretTarget[] = [
      { id: null, label: 'global — every workspace' },
      ...workspaces.map((w) => ({ id: w.id, label: `${w.displayName || w.name} only` })),
    ];
    return (
      <SecretEditor
        mode={editing.mode}
        initial={editing.mode === 'edit'
          ? { name: editing.row.name, description: editing.row.description, workspaceId: editing.row.workspace ?? null }
          : { workspaceId: filter }}
        targets={targets}
        onSave={save} onCancel={() => setEditing(null)}
      />
    );
  }

  // ‹ all ›: one group per layer — global, then each workspace that has
  // rows — under a heading, each row tagged with its layer. One workspace:
  // its rows alone, no heading and no tag — the title already names it.
  const choice = (r: Row): Choice<string> => ({
    value: keyOf(r.workspace, r.name), label: r.name,
    ...(filter === null ? { detail: layerOf(r) } : {}),
    hint: r.description || '(no description)',
  });
  const choices: Choice<string>[] = [];
  if (filter === null) {
    const groups: Array<[string, Row[]]> = [
      [GLOBAL_TAG, shown.filter((r) => r.scope === 'global')],
      ...workspaces.map((w): [string, Row[]] => [wsName(w.id), shown.filter((r) => r.workspace === w.id)]),
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
    <Screen title={workspaces.length ? `secrets · ‹ ${where} ›` : 'secrets'}
      sub="for the coding agent · global, then each workspace's own"
      busy={busy} notice={notice ?? (shown.length === 0
        ? (filter === null ? 'no secrets yet — [n] adds one' : `no secrets of ${where}'s own — [n] adds one, ‹ all › shows the global ones`)
        : undefined)}
      footer={[
        { key: '←→', does: 'workspace', when: workspaces.length > 0 },
        { key: 'enter', does: 'edit' }, { key: 'n', does: 'new secret' },
        { key: 'd', does: 'remove' }, { key: 'esc', does: 'close' },
      ]}>
      <SelectList
        choices={choices}
        initial={last}
        onSelect={(v) => {
          setLast(v);
          const row = shown.find((r) => keyOf(r.workspace, r.name) === v);
          if (row) setEditing({ mode: 'edit', row });
        }}
        onCancel={onClose}
        onKey={(ch, v) => {
          if (ch === 'n') { setEditing({ mode: 'new' }); return; }
          if (ch !== 'd' || !v) return;
          const row = shown.find((r) => keyOf(r.workspace, r.name) === v);
          if (!row) return;
          run(() => api('DELETE', `/secrets/${encodeURIComponent(row.name)}${scopeQuery(row.workspace)}`),
            `${row.name} removed (${layerOf(row)})`);
        }}
      />
    </Screen>
  );
}
