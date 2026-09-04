// The /tasks screen — what is running in the session's container right now,
// plus recent finished commands with their exit codes. Rows come from
// GET /sessions/:id/tasks, read fresh: the server asks the container itself
// (ps inside it) on every call, so what this screen shows is never a cached
// guess. [k] kills the highlighted running task — warn once, [k] again acts,
// the same shape as /resume's [t].
import { SelectList, type Choice } from './SelectList.js';
import { Screen } from './Screen.js';
import { ago } from './Launcher.js';
import { tableChoices, type TableRow } from './table.js';

// The wire shapes, declared here like Launcher's SessionInfo — the cli talks
// HTTP only and never imports server code.
export interface TaskInfo {
  sid: string; command: string; cmd_id: string | null; logs: string | null;
  log_file: string | null; started_at: string | null; elapsed: string; pids: number;
}
export interface RecentInfo {
  cmd_id: string; command: string; status: string; exit_code: number | null;
  started_at: string; ended_at: string | null; logs: string; log_file: string;
}
export interface TasksView {
  container: 'running' | 'stopped' | 'absent';
  tasks: TaskInfo[];
  recent: RecentInfo[];
}

/** What a row stands for. Only live rows can be killed. */
export type TaskPick = { kind: 'live'; sid: string; command: string } | { kind: 'done'; cmdId: string };

// Fixed widths: this is a status list refreshing in place — columns must not
// jitter as statuses flip and clocks tick (table.ts's rule, /resume's too).
const COLS = [
  { title: 'status', width: 14 }, // 'exited (137)' is 12 + the 2-cell gutter
  { title: 'started', width: 10 },
  { title: 'ended', width: 10 }, // blank while running
  { title: 'pid' }, // the sid IS the leader's pid (setsid'd exec) — the kill target
];

/** Rows for the list — pure, exported for tests. Live tasks first, finished
 *  ones under their own dim heading; headings carry the empty states so the
 *  screen always says why it is empty. One shared table system (table.ts)
 *  owns the column geometry. */
export function taskChoices(view: TasksView, now = Date.now()): Choice<TaskPick | null>[] {
  const started = (iso: string | null) => (iso ? ago(iso, now) : '·');
  // ONE tableChoices call over every row, live and finished together —
  // SelectList sizes the label column over the whole list, so the header
  // must be computed over the same data or a long finished command would
  // skew the live rows out from under it.
  const live = view.tasks.map((t): TableRow<TaskPick | null> => ({
    value: { kind: 'live', sid: t.sid, command: t.command },
    cells: [t.command, 'running', started(t.started_at), '', t.sid],
    busy: true,
    hint: t.log_file ? `output: ${t.log_file}`
      : 'not started by a tracked command — [k] still kills it',
  }));
  const done = view.recent.map((r): TableRow<TaskPick | null> => ({
    value: { kind: 'done', cmdId: r.cmd_id },
    cells: [r.command,
      r.status === 'exited' && r.exit_code != null ? `exited (${r.exit_code})` : r.status,
      started(r.started_at),
      r.ended_at ? ago(r.ended_at, now) : '·',
      ''], // a finished command has no live process to name
    hint: `output: ${r.log_file}`,
  }));
  const [header, ...rows] = tableChoices('command', COLS, [...live, ...done]);
  const out: Choice<TaskPick | null>[] = [];
  if (live.length) out.push(header, ...rows.slice(0, live.length));
  else out.push({ value: null, heading: true,
    label: view.container === 'running'
      ? 'nothing running'
      : 'container not running — tasks appear when the agent runs commands' });
  // A blank spacer row above `finished` — the live table and the finished
  // section read as one dense block without it.
  if (done.length) out.push(
    { value: null, heading: true, label: '' },
    { value: null, heading: true, label: 'finished' },
    ...rows.slice(live.length));
  return out;
}

export function Tasks({ view, notice, onKill, onCancel }: {
  view: TasksView;
  notice?: string;
  onKill: (sid: string, command: string) => void;
  onCancel: () => void;
}) {
  return (
    <Screen title="tasks" notice={notice}
      footer={[{ key: 'k', does: 'kill', when: view.tasks.length > 0 }, { key: 'esc', does: 'close' }]}>
      <SelectList
        choices={taskChoices(view)}
        onSelect={() => {}}
        onCancel={onCancel}
        onKey={(ch, v) => { if (ch === 'k' && v?.kind === 'live') onKill(v.sid, v.command); }}
      />
    </Screen>
  );
}
