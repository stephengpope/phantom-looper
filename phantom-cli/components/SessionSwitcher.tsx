// ctrl+n — the sessions you have open in this window.
//
// Not /resume: that lists what the SERVER has and opens one. This lists what is
// already loaded here, running or not, and costs no request. The two are
// different questions and so they are different screens.
//
// A row says what that session is doing, in the same column where an idle one
// says when you last spoke to it — one slot, never both (Shockwave's
// ChatSidebar puts the spinner exactly where the timestamp goes).
import { SelectList, type Choice } from './SelectList.js';
import { Screen } from './Screen.js';
import { ago } from './Launcher.js';
import type { LoadedSession } from '../sessions.js';
import type { WorkspaceInfo } from './Launcher.js';
import { label as workspaceLabel } from './Launcher.js';

/** The last thing you typed at this session — read from the history already in
 *  memory, so nothing is stored twice and nothing is read off disk. */
export function lastSaid(s: Pick<LoadedSession, 'history'>): string | undefined {
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((c) => (c as { type?: string }).type === 'text')
            .map((c) => (c as { text?: string }).text ?? '').join('')
        : '';
    if (text.trim()) return text.trim().replace(/\s+/g, ' ');
  }
  return undefined;
}

export function switcherChoices(
  sessions: LoadedSession[],
  activeId: string,
  workspaces: WorkspaceInfo[] = [],
  now = Date.now(),
): Choice<string>[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  return sessions.map((s) => {
    const w = byId.get(s.workspaceId);
    const said = lastSaid(s);
    // The one status column. `working` beats `new` beats how long ago, because
    // a row that is doing something is the only reason to look at this list.
    const state = s.busy
      ? 'working…'
      : s.unseen
        ? '● answered'
        : s.lastMessageAt
          ? ago(new Date(s.lastMessageAt).toISOString(), now)
          : 'nothing said yet';
    // The workspace alone does not name a row: two sessions in one workspace
    // are two identical lines. The branch is the session's own name, so it is
    // what makes the row its subject rather than its category.
    return {
      value: s.id,
      label: `${w ? workspaceLabel(w) : s.workspaceId} · ${s.branch}`,
      detail: `${said ? `"${said.slice(0, 40)}${said.length > 40 ? '…' : ''}"  ` : ''}${
        s.id === activeId && !s.busy ? 'you are here' : state}`,
      busy: s.busy,
      hint: s.id === activeId
        ? 'the session on screen — enter just closes this list'
        : `switch to ${s.branch}`,
    };
  });
}

export function SessionSwitcher({ sessions, activeId, workspaces, onPick, onCancel }: {
  sessions: LoadedSession[];
  activeId: string;
  workspaces?: WorkspaceInfo[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <Screen title="open sessions" sub="loaded in this window"
      footer={[
        { key: '↑↓', does: 'choose' }, { key: 'enter', does: 'switch' },
        { key: 'esc', does: 'close' },
      ]}>
      <SelectList
        choices={switcherChoices(sessions, activeId, workspaces)}
        onSelect={onPick}
        onCancel={onCancel}
      />
    </Screen>
  );
}
