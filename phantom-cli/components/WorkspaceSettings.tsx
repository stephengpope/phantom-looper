// One workspace: what it is, and the settings it does differently from
// everyone else. Reached with `e` from the workspace list.
//
// Three groups, because they are three different kinds of thing and mixing
// them is how you end up changing a server-wide value believing it was local:
//
//   this workspace   its own identity — name, branch, prefix, its GitHub token
//   settings         the seven that can differ here; every other setting is
//                    global-only and lives on /settings
//   danger           delete
//
// Every settings row says where its value came from — built-in, global, or
// this workspace — and `d` removes the workspace's value so the row follows
// the global one again. That is NOT the same as setting it to whatever the
// global value happens to be today: an unset row keeps following when the
// global changes, a set one does not.
//
// The whole screen renders from ONE call — GET /workspaces/:id — which
// returns the row plus `settings`: every setting with its layers (default /
// global / workspace), the computed value + source, description, meta and
// overridable. Nothing here hardcodes what a setting is, so a new overridable
// setting appears on its own.
import { useCallback, useEffect, useState } from 'react';
import { SelectList } from './SelectList.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import type { Api } from './Settings.js';
import type { WorkspaceInfo } from './Launcher.js';
import { fit, human, labelFor, type WireMeta } from '../settingLabels.js';

interface Effective {
  value: unknown; source: 'default' | 'override' | 'workspace' | 'session';
  default?: unknown; global?: unknown; workspace?: unknown;
  description: string; overridable: boolean;
  meta: WireMeta;
}
interface Row {
  id: string; owner: string; name: string; displayName?: string | null;
  baseBranch: string; branchPrefix: string; hasCredential: boolean;
  settings: Record<string, Effective>;
}

type View =
  | { at: 'list' }
  | { at: 'edit'; key: string; spec: EditSpec; kind: 'field' | 'setting' | 'credential' }
  | { at: 'confirm' };

// The right-hand column answers one question: is this workspace different from
// the others? Two answers, not four — which settings row a value came from is
// the wrong level of detail here, and "override" is the API's word anyway.
const setHere = (source: string) => source === 'workspace';
const WHENCE = (source: string) => setHere(source) ? 'changed here' : 'same as everywhere';

export function WorkspaceSettings({ api, workspace, onClose, onChanged }: {
  api: Api;
  workspace: WorkspaceInfo;
  onClose: () => void;
  /** Fired after any write, so the caller can refresh its workspace list. */
  onChanged?: () => void;
}) {
  const [view, setView] = useState<View>({ at: 'list' });
  // The row the list left from, so the cursor comes back to it after the
  // editor (or the delete prompt) rather than to the top.
  const [last, setLast] = useState<string | undefined>();
  const [row, setRow] = useState<Row | null>(null);
  const [eff, setEff] = useState<Record<string, Effective> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const w = await api('GET', `/workspaces/${workspace.id}`) as Row;
      setRow(w);
      setEff(w.settings);
      setNotice(undefined);
    } catch (err) { setNotice(`could not load: ${(err as Error).message}`); }
    finally { setBusy(false); }
  }, [api, workspace.id]);

  useEffect(() => { void load(); }, [load]);

  // One write path for everything on the list, so the reload and the error
  // handling cannot drift between them.
  const write = useCallback(async (what: () => Promise<unknown>, after?: string) => {
    setBusy(true);
    try {
      await what();
      await load();
      setNotice(after);
      onChanged?.();
    } catch (err) { setNotice((err as Error).message); }
    finally { setBusy(false); setView({ at: 'list' }); }
  }, [load, onChanged]);

  if (view.at === 'confirm') {
    return (
      <Screen title={`delete ${workspace.displayName || workspace.name}?`} busy={busy} notice={notice}
        footer={[{ key: 'enter', does: 'choose' }, { key: 'esc', does: 'back' }]}>
        <SelectList
          choices={[
            { value: false, label: 'keep it', detail: '' },
            { value: true, label: 'delete it', detail: 'cannot be undone',
              hint: 'Deletes the workspace and its data. The GitHub repo is untouched. Refused while a session is running.' },
          ]}
          onSelect={(yes) => {
            if (!yes) { setView({ at: 'list' }); return; }
            // Not `write`: there is nothing left to reload afterwards, and the
            // 404 that reload would hit reads as a failure when it succeeded.
            setBusy(true);
            void api('DELETE', `/workspaces/${workspace.id}?confirm=true`)
              .then(() => { onChanged?.(); onClose(); })
              .catch((err: Error) => { setNotice(err.message); setView({ at: 'list' }); })
              .finally(() => setBusy(false));
          }}
          onCancel={() => setView({ at: 'list' })}
        />
      </Screen>
    );
  }

  if (view.at === 'edit') {
    return (
      <ValueInput
        spec={view.spec}
        onCancel={() => setView({ at: 'list' })}
        onSubmit={(v) => {
          if (view.kind === 'credential') {
            if (v === null) { setView({ at: 'list' }); return; }   // empty = changed my mind
            void write(() => api('PUT', `/workspaces/${workspace.id}/credential`, { token: String(v) }),
              'this workspace now uses its own GitHub token');
            return;
          }
          void write(() => api('PATCH', `/workspaces/${workspace.id}`, { [view.key]: v }));
        }}
      />
    );
  }

  const label = workspace.displayName || workspace.name;
  if (!eff || !row) {
    return <Screen title={label} busy={busy} notice={notice} footer={[{ key: 'esc', does: 'back' }]} />;
  }

  // Deliberate order, not the server's. `agent_git_credentials` hands over
  // the token on the row above it, so it sits right under it; then the
  // auto-push switch. Anything the server adds later that is not named
  // here still shows, at the end.
  const ORDER = ['agent_git_credentials', 'auto_push_on_archive',
    'container_image', 'initial_history_depth', 'spare_clones', 'session_idle_destroy_ms'];
  const overridable = Object.keys(eff).filter((k) => eff[k].overridable);
  const settingKeys = [
    ...ORDER.filter((k) => overridable.includes(k)),
    ...overridable.filter((k) => !ORDER.includes(k)),
  ];

  // No group headings. Every one of them ("about X", "settings · X only",
  // "deleting cannot be undone") said something the rows underneath already
  // said, in a dim line that looks like content — three restatements of the
  // workspace name on a screen whose title is the workspace name. A row that
  // needs a heading to be understood is a row that is badly labelled; fix the
  // row. The only separator left is blank, before the one irreversible action.
  const choices = [
    { value: 'display_name', label: 'name', detail: fit(row.displayName ?? row.name),
      hint: `What you call it here. It is ${row.owner}/${row.name} on GitHub either way.` },
    { value: 'base_branch', label: 'base branch', detail: fit(row.baseBranch),
      hint: 'The branch work starts from and goes back to.' },
    { value: 'branch_prefix', label: 'branch prefix', detail: fit(row.branchPrefix),
      hint: 'Starts every session branch name: prefix/session-id.' },
    // The PAT and the switch that hands it to the agent are two different
    // decisions and were two unrelated-looking rows. They name each other now.
    { value: 'credential', label: 'github token',
      detail: row.hasCredential ? `${label}'s own` : 'the shared one from /keys',
      hint: row.hasCredential
        ? 'This workspace has its own GitHub token. It is never shown back.'
        : 'This workspace uses the shared GitHub token from /keys. [enter] gives it one of its own.' },

    ...settingKeys.map((k) => {
      const s = eff[k];
      return {
        value: k,
        label: labelFor(k, s.meta),
        columns: [
          { text: fit(human(s.value, s.meta), 30), width: 32 },
          { text: WHENCE(s.source) },
        ],
        // The description alone; the columns already say the value and
        // whether this workspace differs.
        hint: s.description,
      };
    }),

    { value: '#gap', label: '', heading: true },
    { value: 'delete', label: `delete ${label}`, detail: 'cannot be undone',
      hint: 'Deletes the workspace and its data. The GitHub repo is untouched. Refused while a session is running.' },
  ];

  return (
    <Screen title={`${label} · ${row.owner}/${row.name}`} busy={busy} notice={notice}
      footer={[
        { key: 'enter', does: 'change' }, { key: 'd', does: 'use the shared value' },
        { key: 'esc', does: 'back' },
      ]}>
      <SelectList
        key="workspace"
        initial={last}
        choices={choices}
        onCancel={onClose}
        onSelect={(k) => {
          setLast(k);
          if (k === 'delete') { setView({ at: 'confirm' }); return; }
          if (k === 'credential') {
            setView({ at: 'edit', kind: 'credential', key: 'credential', spec: {
              title: 'github token for this workspace', type: 'string', secret: true, current: '',
              note: 'stored encrypted, never shown back · empty cancels',
            } });
            return;
          }
          if (k === 'display_name' || k === 'base_branch' || k === 'branch_prefix') {
            const current = k === 'display_name' ? row.displayName ?? row.name
              : k === 'base_branch' ? row.baseBranch : row.branchPrefix;
            setView({ at: 'edit', kind: 'field', key: k, spec: {
              title: k === 'display_name' ? 'name' : k.replace(/_/g, ' '), type: 'string', current,
              note: k === 'display_name' ? 'empty goes back to the GitHub name' : undefined,
            } });
            return;
          }
          const s = eff[k];
          if (!s) return;
          setView({ at: 'edit', kind: 'setting', key: k, spec: {
            title: `${labelFor(k, s.meta)} · ${label} only`,
            choices: s.meta.choices,
            choiceLabels: s.meta.choiceLabels,
            type: s.meta.type,
            current: s.value,
            note: s.meta.unit === 'ms'
              ? `in milliseconds · now ${human(s.value, s.meta)}, ${WHENCE(s.source)}`
              : `changes this workspace only · now ${human(s.value, s.meta)}, ${WHENCE(s.source)}`,
          } });
        }}
        onKey={(ch, k) => {
          // `d` only means something for a row this workspace actually sets —
          // on an inherited row there is nothing to remove, and sending null
          // anyway would look like it did something.
          if (ch !== 'd' || !k) return;
          if (k === 'credential') {
            if (!row.hasCredential) { setNotice(`${label} is already using the shared token`); return; }
            void write(() => api('DELETE', `/workspaces/${workspace.id}/credential`),
              `${label} is back on the shared token from /keys`);
            return;
          }
          if (k === 'display_name') {
            if ((row.displayName ?? null) !== null) void write(() => api('PATCH', `/workspaces/${workspace.id}`, { display_name: '' }));
            return;
          }
          const s = eff[k];
          if (!s?.overridable) return;
          if (!setHere(s.source)) { setNotice(`"${labelFor(k, s.meta)}" is not set here — it already uses the shared value`); return; }
          void write(() => api('PATCH', `/workspaces/${workspace.id}`, { [k]: null }));
        }}
      />
    </Screen>
  );
}
