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
import type { ProjectInfo } from './Launcher.js';
import { label as projectLabel } from './Launcher.js';

/** The last thing you typed at this session — read from the history already in
 *  memory, so nothing is stored twice and nothing is read off disk. */
export function lastSaid(session: Pick<LoadedSession, 'history'>): string | undefined {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const message = session.history[i];
    if (message.role !== 'user') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part) => (part as { type?: string }).type === 'text')
            .map((part) => (part as { text?: string }).text ?? '').join('')
        : '';
    if (text.trim()) return text.trim().replace(/\s+/g, ' ');
  }
  return undefined;
}

export function switcherChoices(
  sessions: LoadedSession[],
  activeId: string,
  projects: ProjectInfo[] = [],
  now = Date.now(),
): Choice<string>[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return sessions.map((session) => {
    const project = byId.get(session.projectId);
    const said = lastSaid(session);
    // The one status column. `waiting on you` beats `working` beats `new`
    // beats how long ago: a row whose agent is stopped on a question for you
    // is the first reason to look at this list, a row doing something the
    // second.
    const state = session.ask
      ? '● waiting on you'
      : session.busy
      ? 'working…'
      : session.unseen
        ? '● answered'
        : session.lastMessageAt
          ? ago(new Date(session.lastMessageAt).toISOString(), now)
          : 'nothing said yet';
    // The project alone does not name a row: two sessions in one project
    // are two identical lines. The branch is the session's own name, so it is
    // what makes the row its subject rather than its category.
    return {
      value: session.id,
      label: `${project ? projectLabel(project) : session.projectId} · ${session.branch}`,
      detail: `${session.summary.model}  ${said ? `"${said.slice(0, 40)}${said.length > 40 ? '…' : ''}"  ` : ''}${
        session.id === activeId && !session.busy ? 'you are here' : state}`,
      // No spinner on a row that is stopped waiting for your answer.
      busy: session.busy && !session.ask,
      busySince: session.startedAt,
      hint: session.id === activeId
        ? 'the session on screen — enter just closes this list'
        : `switch to ${session.branch}`,
    };
  });
}

export function SessionSwitcher({ sessions, activeId, projects, onPick, onCancel }: {
  sessions: LoadedSession[];
  activeId: string;
  projects?: ProjectInfo[];
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
        choices={switcherChoices(sessions, activeId, projects)}
        onSelect={onPick}
        onCancel={onCancel}
      />
    </Screen>
  );
}
