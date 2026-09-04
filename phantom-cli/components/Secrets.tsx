// The secrets the server holds for the coding agent — tokens the AGENT uses
// in the work (service API keys, deploy tokens), as opposed to /keys, the
// credentials that power phantom-looper itself. Stored encrypted on the
// server's settings table (the `secret` namespace); the agent reads them
// through secret_list / secret_get.
//
// ONE list, EVERY layer: all global secrets plus every workspace's own,
// each row tagged with where it lives (global / the workspace's name). The
// same name at two layers lists twice — the workspace one is what that
// workspace's agent gets. [n] and [enter] open the SecretEditor — the
// card-style popup, every field on one screen, Where cycling global + every
// workspace, esc killing it whole; re-saving a name at a layer overwrites
// it (that IS the update path); [d] deletes at the highlighted row's layer.
import { useCallback, useEffect, useState } from 'react';
import { SelectList } from './SelectList.js';
import { SecretEditor, type SecretDraft, type SecretTarget } from './SecretEditor.js';
import { Screen } from './Screen.js';
import { useInput } from 'ink';
import type { Api } from '../settings.js';

const GLOBAL_TAG = 'global';

interface Row { name: string; description: string; scope: 'global' | 'workspace'; workspace?: string }

export function Secrets({ api, onClose }: { api: Api; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [wsNames, setWsNames] = useState<Map<string, string>>(new Map());
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; row: Row } | null>(null);
  // The row the list comes back to after the editor: the one opened, or the
  // one a save just made — a new secret lands under the cursor, not off it.
  const [last, setLast] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // The bare list is every layer; the workspaces call names the tags and
      // the editor's Where targets. One failure fails the screen honestly.
      const [r, ws] = await Promise.all([
        api('GET', '/secrets') as Promise<{ secrets: Row[] }>,
        api('GET', '/workspaces') as Promise<Array<{ id: string; name: string; displayName?: string | null }>>,
      ]);
      setWsNames(new Map(ws.map((w) => [w.id, w.displayName || w.name])));
      setRows(r.secrets);
      setNotice(undefined);
    } catch (e) { setNotice(`could not load: ${(e as Error).message}`); setRows([]); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const wsName = (id?: string) => (id && wsNames.get(id)) || id || GLOBAL_TAG;
  const layerOf = (r: Row) => (r.scope === 'workspace' ? wsName(r.workspace) : GLOBAL_TAG);

  const run = (what: () => Promise<unknown>, after: string) => {
    setBusy(true);
    void what()
      .then(async () => { await load(); setNotice(after); })
      .catch((e: Error) => setNotice(e.message))
      .finally(() => { setBusy(false); setEditing(null); });
  };

  const save = (d: SecretDraft) => {
    const q = d.workspaceId ? `?workspace=${encodeURIComponent(d.workspaceId)}` : '';
    setLast(`${d.workspaceId ?? ''}|${d.name}`);
    run(() => api('PUT', `/secrets/${encodeURIComponent(d.name)}${q}`,
      { description: d.description, value: d.value }),
    `${d.name} saved (${wsName(d.workspaceId ?? undefined)})`);
  };

  // The empty state has no SelectList to catch keys, so this screen listens
  // itself — only then, or the two would both see every press.
  useInput((ch, key) => {
    if (key.escape) { onClose(); return; }
    if (ch === 'n') setEditing({ mode: 'new' });
  }, { isActive: editing === null && (rows?.length ?? 1) === 0 });

  if (editing) {
    const targets: SecretTarget[] = [
      { id: null, label: 'global — every workspace' },
      ...[...wsNames.entries()].map(([id, label]) => ({ id, label: `${label} only` })),
    ];
    return (
      <SecretEditor
        mode={editing.mode}
        {...(editing.mode === 'edit' ? { initial: {
          name: editing.row.name, description: editing.row.description,
          workspaceId: editing.row.workspace ?? null, scopeLabel: layerOf(editing.row),
        } } : {})}
        targets={targets}
        onSave={save} onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <Screen title="secrets"
      sub="for the coding agent · every workspace's, tagged"
      busy={busy} notice={notice ?? ((rows?.length ?? 1) === 0 ? 'no secrets yet — [n] adds one' : undefined)}
      footer={[
        { key: 'enter', does: 'edit' }, { key: 'n', does: 'new secret' },
        { key: 'd', does: 'remove' }, { key: 'esc', does: 'close' },
      ]}>
      <SelectList
        choices={(rows ?? []).map((r) => ({
          value: `${r.workspace ?? ''}|${r.name}`,
          label: r.name,
          detail: layerOf(r),
          hint: r.description || '(no description)',
        }))}
        initial={last}
        onSelect={(v) => {
          // Enter edits at the row's OWN layer: description + a fresh value
          // (the server never hands a secret back to a screen).
          setLast(v);
          const [ws, name] = v.split('|', 2);
          const row = (rows ?? []).find((r) => (r.workspace ?? '') === ws && r.name === name);
          if (row) setEditing({ mode: 'edit', row });
        }}
        onCancel={onClose}
        onKey={(ch, v) => {
          if (ch === 'n') { setEditing({ mode: 'new' }); return; }
          if (ch !== 'd' || !v) return;
          const [ws, name] = v.split('|', 2);
          const q = ws ? `?workspace=${encodeURIComponent(ws)}` : '';
          run(() => api('DELETE', `/secrets/${encodeURIComponent(name)}${q}`),
            `${name} removed (${wsName(ws || undefined)})`);
        }}
      />
    </Screen>
  );
}
