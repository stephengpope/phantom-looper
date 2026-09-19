// One workspace: what it is, and the settings it does differently from
// everyone else. Reached with `e` from the workspace list.
//
// Three kinds of row, because mixing them is how you end up changing a
// server-wide value believing it was local:
//
//   the workspace    its own identity — name, branch, prefix, its GitHub token
//   settings         the ones the server says can differ here (`overridable`),
//                    under the server's group headings (settingGroups.ts) in
//                    the server's order, exactly as /settings files them;
//                    every other setting is global-only and lives on /settings
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
// setting appears on its own. Every override — the token included — is
// written through PATCH /settings?workspace=, the one door for a workspace's
// layer; only the three own fields go to PATCH /workspaces/:id.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SelectList } from './SelectList.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import type { Api } from './Settings.js';
import type { WorkspaceInfo } from './Launcher.js';
import { fit, human, labelFor, type WireMeta } from '../settingLabels.js';
import { makeSettings } from '../settings.js';
import { groupBlocks, headedChoices } from '../settingGroups.js';
import type { ConfigValue } from '../config.js';

interface Effective {
  value: unknown; source: 'default' | 'global' | 'workspace';
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
// the others? Two answers, not three — whether the shared value is the code
// default or a global row is the wrong level of detail here.
const setHere = (source: string) => source === 'workspace';
const WHENCE = (source: string) => setHere(source) ? 'changed here' : 'same as everywhere';

export function WorkspaceSettings({ api, workspace, onClose, onChanged }: {
  api: Api;
  workspace: WorkspaceInfo;
  onClose: () => void;
  /** Fired after any write, so the caller can refresh its workspace list. */
  onChanged?: () => void;
}) {
  const settings = useMemo(() => makeSettings(api), [api]);
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
            // github_token at this workspace's layer — the same key /keys writes globally.
            void write(() => settings.patch({ github_token: String(v) }, { workspace: workspace.id }),
              'this workspace now uses its own GitHub token');
            return;
          }
          if (view.kind === 'setting') {
            void write(() => settings.patch({ [view.key]: v as ConfigValue }, { workspace: workspace.id }));
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

  // The overridable settings in the server's order, under the server's group
  // headings — the same fold /settings uses, so the two screens agree on
  // where a setting lives and nothing here names or orders a key.
  const overridable = Object.keys(eff).filter((k) => eff[k].overridable);
  const settingRows = headedChoices(groupBlocks(overridable, (k) => eff[k].meta), (k) => {
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
  });

  // The four identity rows carry no heading: they are the workspace itself,
  // and the title above already names it. A blank separates them from the
  // headed settings groups, and another sets off the one irreversible action.
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

    { value: '#gap:settings', label: '', heading: true },
    ...settingRows,

    { value: '#gap:delete', label: '', heading: true },
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
            suggestions: s.meta.suggestions,
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
            // null clears the workspace layer; the global token applies again.
            void write(() => settings.patch({ github_token: null }, { workspace: workspace.id }),
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
          void write(() => settings.patch({ [k]: null }, { workspace: workspace.id }));
        }}
      />
    </Screen>
  );
}
