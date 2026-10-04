// One project: what it is, and the settings it does differently from
// everyone else. Reached with `e` from the project list.
//
// Three kinds of row, because mixing them is how you end up changing a
// server-wide value believing it was local:
//
//   the project    its own facts — name, base branch, branch prefix. No
//                    default to fall back to, so they cannot be cleared.
//   settings         the ones the server says can differ here (`overridable`),
//                    the GitHub token among them, under the server's group
//                    headings (settingGroups.ts) in the server's order,
//                    exactly as /settings files them; every other setting is
//                    global-only and lives on /settings
//   danger           delete
//
// The rule that sorts a row into the first kind or the second: clear it, and
// what does it fall back to? A global value or a code default => a setting.
// Nothing => a fact about this project.
//
// Every settings row says where its value came from — built-in, global, or
// this project — and `d` removes the project's value so the row follows
// the global one again. That is NOT the same as setting it to whatever the
// global value happens to be today: an unset row keeps following when the
// global changes, a set one does not.
//
// The whole screen renders from ONE call — GET /projects/:id — which
// returns the row plus `settings`: every setting with its layers (default /
// global / project), the computed value + source, description, meta and
// overridable; the token is in there as `secret`, source only, never the
// value. Nothing here hardcodes what a setting is, so a new overridable
// setting appears on its own. Every override — the token included — is
// written through PATCH /settings?project=, the one door for a project's
// layer; only the three own fields go to PATCH /projects/:id.
//
// The coding agent's provider and model rows get the pickers /settings has
// (the same helpers: keyed providers, the provider's catalog, a provider
// change blanks the model). The server's PROVIDER-FIRST rule (a project
// model lives under the project's own provider) is met here without a
// refusal ever showing: saving a model or endpoint sends the provider it
// was picked under in the same patch.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SelectList } from './SelectList.js';
import { ValueInput, type EditSpec } from './ValueInput.js';
import { Screen } from './Screen.js';
import { HIDDEN, MODEL_FOR_PROVIDER, MODEL_ROWS, buildModelSpec, providerForModelRow, type Api, type CatalogModel } from './Settings.js';
import type { ProjectInfo } from './Launcher.js';
import { fit, human, labelFor, type WireMeta } from '../settingLabels.js';
import { makeSettings } from '../settings.js';
import { groupBlocks, headedChoices } from '../settingGroups.js';
import type { ConfigValue } from '../config.js';

interface Effective {
  value: unknown; source: 'default' | 'global' | 'project';
  default?: unknown; global?: unknown; project?: unknown;
  description: string; overridable: boolean; secret?: boolean;
  meta: WireMeta;
}
interface Row {
  id: string; owner: string; name: string; displayName?: string | null;
  baseBranch: string; branchPrefix: string;
  settings: Record<string, Effective>;
}

type View =
  | { at: 'list' }
  | { at: 'edit'; key: string; spec: EditSpec; kind: 'field' | 'setting' }
  | { at: 'confirm' };

// The right-hand column answers one question: is this project different from
// the others? Two answers, not three — whether the shared value is the code
// default or a global row is the wrong level of detail here.
const setHere = (source: string) => source === 'project';
const WHENCE = (source: string) => setHere(source) ? 'changed here' : 'same as everywhere';
// A secret's value column: it is never shown back, so say whose it is.
const shownValue = (effective: Effective) =>
  effective.secret ? (setHere(effective.source) ? 'its own' : effective.source === 'global' ? 'the shared one from /keys' : 'none set') : human(effective.value, effective.meta);

export function ProjectSettings({ api, project, onClose, onChanged }: {
  api: Api;
  project: ProjectInfo;
  onClose: () => void;
  /** Fired after any write, so the caller can refresh its project list. */
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
      const row = await api('GET', `/projects/${project.id}`) as Row;
      setRow(row);
      setEff(row.settings);
      setNotice(undefined);
    } catch (err) { setNotice(`could not load: ${(err as Error).message}`); }
    finally { setBusy(false); }
  }, [api, project.id]);

  useEffect(() => { void load(); }, [load]);

  // The server's model catalog, read when a model row's editor opens; a
  // server that cannot answer leaves the row free-text (as /settings).
  const loadModels = useCallback(async (provider: string): Promise<CatalogModel[]> => {
    try {
      const reply = await api('GET', `/models?provider=${encodeURIComponent(provider)}`) as { models?: CatalogModel[] };
      return Array.isArray(reply?.models) ? reply.models : [];
    } catch (entry) { setNotice(`could not load the model list: ${(entry as Error).message}`); return []; }
  }, [api]);

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
      <Screen title={`delete ${project.displayName || project.name}?`} busy={busy} notice={notice}
        footer={[{ key: 'enter', does: 'choose' }, { key: 'esc', does: 'back' }]}>
        <SelectList
          choices={[
            { value: false, label: 'keep it', detail: '' },
            { value: true, label: 'delete it', detail: 'cannot be undone',
              hint: 'Deletes the project and its data. Your GitHub repo is not deleted. Refused while a session is running.' },
          ]}
          onSelect={(yes) => {
            if (!yes) { setView({ at: 'list' }); return; }
            // Not `write`: there is nothing left to reload afterwards, and the
            // 404 that reload would hit reads as a failure when it succeeded.
            setBusy(true);
            void api('DELETE', `/projects/${project.id}?confirm=true`)
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
        onSubmit={(value) => {
          if (view.kind === 'setting') {
            // An empty secret = changed my mind, not "store an empty token".
            if (view.spec.secret && value === null) { setView({ at: 'list' }); return; }
            const patch: Record<string, ConfigValue> = { [view.key]: value as ConfigValue };
            // A provider change invalidates its model (as /settings). A model
            // or endpoint carries the provider it was picked under, so the
            // project owns the pair (the server's provider-first rule).
            const modelKey = MODEL_FOR_PROVIDER[view.key];
            if (modelKey && value !== view.spec.current) patch[modelKey] = null;
            const provider = eff?.coding_provider.value;
            if ((MODEL_ROWS[view.key] || view.key === 'coding_base_url') && value !== null && typeof provider === 'string') {
              patch.coding_provider = provider;
            }
            void write(() => settings.patch(patch, { project: project.id }));
            return;
          }
          void write(() => api('PATCH', `/projects/${project.id}`, { [view.key]: value }));
        }}
      />
    );
  }

  const label = project.displayName || project.name;
  if (!eff || !row) {
    return <Screen title={label} busy={busy} notice={notice} footer={[{ key: 'esc', does: 'back' }]} />;
  }

  // The overridable settings in the server's order, under the server's group
  // headings — the same fold /settings uses, so the two screens agree on
  // where a setting lives and nothing here names or orders a key.
  const values = Object.fromEntries(Object.entries(eff).map(([key, entry]) => [key, entry.value]));
  const overridable = Object.keys(eff).filter((key) => eff[key].overridable && !HIDDEN[key]?.(values));
  const settingRows = headedChoices(groupBlocks(overridable, (key) => eff[key].meta), (key) => {
    const effective = eff[key];
    return {
      value: key,
      label: labelFor(key, effective.meta),
      columns: [
        { text: fit(shownValue(effective), 30), width: 32 },
        { text: WHENCE(effective.source) },
      ],
      // The description alone; the columns already say the value and
      // whether this project differs.
      hint: effective.description,
    };
  });

  // The three own rows carry no heading: they are the project itself, and
  // the title above already names it. A blank separates them from the headed
  // settings groups, and another sets off the one irreversible action.
  const choices = [
    { value: 'display_name', label: 'name', detail: fit(row.displayName ?? row.name),
      hint: `What you call it here. It is ${row.owner}/${row.name} on GitHub either way.` },
    { value: 'base_branch', label: 'base branch', detail: fit(row.baseBranch),
      hint: 'The branch work starts from and goes back to.' },
    { value: 'branch_prefix', label: 'branch prefix', detail: fit(row.branchPrefix),
      hint: 'Starts every session branch name: prefix/session-id.' },

    { value: '#gap:settings', label: '', heading: true },
    ...settingRows,

    { value: '#gap:delete', label: '', heading: true },
    { value: 'delete', label: `delete ${label}`, detail: 'cannot be undone' },
  ];

  return (
    <Screen title={`${label} · ${row.owner}/${row.name}`} busy={busy} notice={notice}
      footer={[
        { key: 'enter', does: 'change' }, { key: 'd', does: 'use the shared value' },
        { key: 'esc', does: 'back' },
      ]}>
      <SelectList
        key="project"
        initial={last}
        choices={choices}
        onCancel={onClose}
        onSelect={(key) => {
          setLast(key);
          if (key === 'delete') { setView({ at: 'confirm' }); return; }
          if (key === 'display_name' || key === 'base_branch' || key === 'branch_prefix') {
            const current = key === 'display_name' ? row.displayName ?? row.name
              : key === 'base_branch' ? row.baseBranch : row.branchPrefix;
            setView({ at: 'edit', kind: 'field', key, spec: {
              title: key === 'display_name' ? 'name' : key.replace(/_/g, ' '), type: 'string', current,
              note: key === 'display_name' ? 'empty goes back to the GitHub name' : undefined,
            } });
            return;
          }
          const effective = eff[key];
          if (!effective) return;
          const spec: EditSpec = {
            title: `${labelFor(key, effective.meta)} · ${label} only`,
            choices: effective.meta.choices,
            choiceLabels: effective.meta.choiceLabels,
            suggestions: effective.meta.suggestions,
            type: effective.meta.type,
            secret: effective.secret,
            current: effective.secret ? '' : effective.value,
            note: effective.secret ? 'stored encrypted, never shown back · empty cancels'
              : effective.meta.unit === 'ms'
                ? `in milliseconds · now ${human(effective.value, effective.meta)}, ${WHENCE(effective.source)}`
                : `changes this project only · now ${human(effective.value, effective.meta)}, ${WHENCE(effective.source)}`,
          };
          const provider = providerForModelRow(key, values);
          void (async () => {
            const models = provider ? await loadModels(provider) : [];
            setView({ at: 'edit', kind: 'setting', key, spec: buildModelSpec(key, spec, values, models, eff) });
          })();
        }}
        onKey={(char, key) => {
          // `d` only means something for a row this project actually sets —
          // on an inherited row there is nothing to remove, and sending null
          // anyway would look like it did something.
          if (char !== 'd' || !key) return;
          if (key === 'display_name') {
            if ((row.displayName ?? null) !== null) void write(() => api('PATCH', `/projects/${project.id}`, { display_name: '' }));
            return;
          }
          const effective = eff[key];
          if (!effective?.overridable) return;
          if (!setHere(effective.source)) { setNotice(`"${labelFor(key, effective.meta)}" is not set here — it already uses the shared value`); return; }
          void write(() => settings.patch({ [key]: null }, { project: project.id }));
        }}
      />
    </Screen>
  );
}
