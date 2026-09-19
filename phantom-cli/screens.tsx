// Every overlay, in one place. An overlay is a screen on top of the chat: a
// FULL one owns the main column (every menu, the board), a THIRD takes the
// bottom third with the conversation still above (the glance lists). Each
// is built here as a plain `Overlay` — what to draw, what to do when it goes
// — and the window shows it with `w.showOverlay`. Closing is one thing
// everywhere: `w.dismissOverlay(result)`. The one thing that goes ON TOP of
// an overlay is the confirm dialog, built here too.
//
// Adding a screen: a builder here, and the store method or slash command
// that shows it (window.ts). There is no third place.
//
// The screens draw from the window store, which also owns their data
// (fetch-first: a screen opens only once its rows have landed, so a dead
// server leaves you on the chat with a note). `render` runs on every App
// render, so a screen reads the store's CURRENT rows each time — the poll
// that refreshes /tasks or a page appended to /resume lands on screen
// without any screen re-opening.
import type { Dialog, Overlay, WindowStore } from './window.js';
import type { Api } from './request.js';
import { Settings } from './components/Settings.js';
import { Launcher } from './components/Launcher.js';
import { NewWorkspace, type NewWorkspaceRequest } from './components/NewWorkspace.js';
import { WorkspaceSettings } from './components/WorkspaceSettings.js';
import { SessionSwitcher } from './components/SessionSwitcher.js';
import { Keys } from './components/Keys.js';
import { Tasks } from './components/Tasks.js';
import { Archived } from './components/Archived.js';
import { Secrets } from './components/Secrets.js';
import { Presets } from './components/Presets.js';
import { Board } from './components/Board.js';
import { Confirm, CONFIRM_ROWS } from './components/Confirm.js';
import { quiet } from './request.js';
import type { WorkspaceInfo } from './components/Launcher.js';

/** /server is the ONE screen that must work with the server down — it is
 *  where you fix the address — so it gets this api and its two keys are the
 *  two that live in the file. */
const offline: Api = async () => ({});

const full = (name: string, render: Overlay['render'], rest: Partial<Overlay> = {}): Overlay =>
  ({ size: 'full', name, render, ...rest });
const third = (name: string, render: Overlay['render'], rest: Partial<Overlay> = {}): Overlay =>
  ({ size: 'third', name, render, ...rest });

// ── the dialog ────────────────────────────────────────────────────────────

/** THE yes/no. enter = true, esc = false; anything that takes it down
 *  (ctrl+c, the screen under it leaving) answers false too — a question
 *  taken off the screen was not answered yes. `who` names an agent asking.
 *  `dismiss` is the slot it lives in: the window's for the app's own safety
 *  checks, a session's for an agent's question (window.ts `confirm`). */
export const confirmDialog = (dismiss: (result?: unknown) => void, title: string, message: string | undefined,
  who: string | undefined, resolve: (yes: boolean) => void): Dialog => ({
  render: () => <Confirm title={title} message={message} who={who} onResult={dismiss} />,
  rows: CONFIRM_ROWS + (message ? 1 : 0),
  onDismiss: (yes) => resolve(yes === true),
});

// ── the board ─────────────────────────────────────────────────────────────

/** The kanban board, with or without a card's editor open on it. ONE
 *  component for both: the board stays mounted while a card is edited, so
 *  the columns keep their place when the editor closes. A card carries where
 *  esc goes BACK to — the columns when it was opened from the board, the chat
 *  from anywhere else (the archive, the Assistant) — because that is the only
 *  thing that ever differed between the two. */
export const boardScreen = (w: WindowStore, workspaceId: string,
  card?: { number: number; back: 'chat' | 'board' }): Overlay =>
  // The name says what is on screen for the Assistant's "is the board up":
  // a card opened FROM the board is still the board.
  full(card?.back === 'chat' ? 'card' : 'board', ({ width, height }) => (
    <Board store={w.boardFor(workspaceId)} width={width} height={height} isActive
      card={card?.number}
      confirm={(t, m) => w.confirm(t, m)}
      onOpenCard={(number) => w.openCard(number, 'board')}
      onCloseCard={() => { if (card?.back === 'board') w.openBoard(); else w.dismissOverlay(); }}
      onClose={w.dismissOverlay}
      // The card editor's Session row: back to chat, then the one open
      // path — already loaded switches, otherwise it opens (read-only
      // while the looper holds it, like /resume).
      onOpenSession={(id) => { w.dismissOverlay(); void w.openSession({ kind: 'open', id }); }}
      // [v]: the archive. Off the board first, so a failed fetch's note
      // lands where you can read it.
      onArchived={() => { w.dismissOverlay(); void w.openArchived(workspaceId); }} />
  ));

// ── the menus ─────────────────────────────────────────────────────────────

/** ctrl+n: the sessions open in this window. */
export const switcherScreen = (w: WindowStore): Overlay => full('sessions', () => (
  <SessionSwitcher
    sessions={w.sessions.list()} activeId={w.sessions.activeId} workspaces={w.workspaceRows}
    onPick={(id) => { w.dismissOverlay(); w.switchTo(id); }}
    onCancel={w.dismissOverlay} />
));

/** /settings — every server setting plus this machine's audio rows; /model
 *  and /assistant open it at their group. Device rows offer what the voice
 *  sidecar found; saving a boot-time key restarts it. */
export const settingsScreen = (w: WindowStore, startAt?: 'coding' | 'assistant'): Overlay => full('settings', () => {
  const vs = w.voice.snapshot();
  return (
    <Settings key={`settings-${w.settingsVersion}`} api={w.api} configPath={w.configPath} title="settings"
      rows={{ server: true, local: 'voice' }} startAt={startAt}
      suggestions={{ voice_mic_device: vs.devices.mics, voice_speaker_device: vs.devices.speakers }}
      onOpenRow={(k) => { if (k === 'voice_mic_device' || k === 'voice_speaker_device') void w.voice.refreshDevices(); }}
      onChange={w.settingChanged} onClose={w.dismissOverlay} />
  );
});

/** /keys — its own screen so there is ONE place any credential is set. A
 *  saved key has to reach the app like any other setting change: the
 *  Assistant takes its Deepgram key at spawn, and the agents take theirs at
 *  build. */
export const keysScreen = (w: WindowStore): Overlay => full('keys', () => (
  <Keys key={`keys-${w.settingsVersion}`} api={w.api} onClose={w.dismissOverlay}
    onChanged={w.settingChanged} />
));

/** /secrets — the agent's secrets, not phantom's own credentials (/keys).
 *  The screen reads every layer itself — no session context needed. */
export const secretsScreen = (w: WindowStore): Overlay => full('secrets', () => (
  <Secrets api={w.api} onClose={w.dismissOverlay} />
));

/** /server — this machine's connection rows, on the offline api (see above). */
export const serverScreen = (w: WindowStore): Overlay => full('server', () => (
  <Settings key={`server-settings-${w.settingsVersion}`}
    api={offline} configPath={w.configPath} title="server" rows={{ local: 'server' }}
    onChange={w.settingChanged} onClose={w.dismissOverlay} />
));

/** /presets. Applying closes the screen — the confirmation and the rebuilt
 *  agents both land in the CLI the user is back at. */
export const presetsScreen = (w: WindowStore): Overlay => full('presets', () => (
  <Presets key={`presets-${w.settingsVersion}`} api={w.api}
    confirm={(t, m) => w.confirm(t, m)}
    onApplied={(name) => {
      w.note(`preset applied: ${name}`);
      w.settingChanged('provider');
    }}
    onClose={w.dismissOverlay} />
));

/** `e` on a /workspace row: that workspace's settings. Closing goes back to
 *  the list it was opened from, refreshed — a rename there has to show up. */
export const workspaceSettingsScreen = (w: WindowStore, workspace: WorkspaceInfo): Overlay =>
  full('workspaceSettings', () => (
    <WorkspaceSettings key={`workspace-settings-${w.settingsVersion}`}
      api={w.api} workspace={workspace}
      onClose={() => { void w.openPicker('workspace'); }}
      onChanged={() => { void w.refreshPicker().catch(quiet('refresh the session list')); }} />
  ));

/** The add-a-workspace form. A rejected submit stays on the form with the
 *  server's words (`w.addError`, read fresh each render — the form must NOT
 *  be re-shown, that would remount it and lose what was typed). */
export const addWorkspaceScreen = (w: WindowStore): Overlay => full('addWorkspace', () => (
  <NewWorkspace api={w.api} error={w.addError}
    onCancel={w.dismissOverlay}
    onSubmit={(req: NewWorkspaceRequest) => { void w.addWorkspace(req); }} />
));

/** /archived — the workspace's archived cards, paged like /resume. */
export const archivedScreen = (w: WindowStore, workspaceId: string): Overlay => full('archived', () => (
  <Archived cards={w.archived} notice={w.archivedNotice}
    onNearEnd={() => { void w.moreArchived(workspaceId); }}
    total={w.archivedTotal}
    // The solo editor renders from the board store, which never holds
    // archived cards on its own — seat this one first.
    onOpen={(t) => w.openArchivedCard(workspaceId, t)}
    onRestore={(t) => { void w.restoreCard(workspaceId, t); }}
    onCancel={w.dismissOverlay} />
));

/** /tasks — what is running in the session's container. Re-read on the
 *  poll while up: rows come and go on their own. */
export const tasksScreen = (w: WindowStore): Overlay => third('tasks', () => (
  w.tasks ? <Tasks view={w.tasks} notice={w.tasksNotice}
    onKill={(sid, cmd) => { void w.killTask(sid, cmd); }}
    onCancel={w.dismissOverlay} /> : null
), { poll: () => { void w.refreshTasks().catch(quiet('refresh tasks')); } });

/** /resume (sessions) and /workspace (workspaces) — one launcher, two
 *  modes. /resume follows the session list feed while up: a row moving
 *  anywhere re-reads the list, so its rows spin and its locks lapse as they
 *  happen. The refresh swaps rows in place, so the cursor and the notice
 *  line stay put. */
export const pickerScreen = (w: WindowStore, which: 'workspace' | 'resume'): Overlay => full(which, () => (
  w.picker ? <Launcher
    mode={which === 'resume' ? 'sessions' : 'workspaces'}
    workspaces={w.workspaceRows} sessions={w.picker.sessions} total={w.picker.total}
    showBackground={w.showBackground}
    onToggleBackground={() => w.toggleBackground()}
    query={w.pickerQuery} rowsQuery={w.picker.query}
    onQuery={which === 'resume' ? (q) => w.setPickerQuery(q) : undefined}
    workspaceId={w.pickerWorkspace}
    onCycleWorkspace={which === 'resume' ? (dir) => w.cyclePickerWorkspace(dir) : undefined}
    busy={(id) => w.sessions.get(id)?.busy ?? false}
    loaded={(id) => w.sessions.has(id)}
    clientId={w.clientId}
    notice={w.pickerNotice}
    onNearEnd={which === 'resume' ? () => { void w.morePicker(); } : undefined}
    onEdit={(id) => w.editWorkspace(id)}
    onDuplicate={(id) => { void w.duplicateFromPicker(id); }}
    onPin={(id) => { void w.pinFromPicker(id); }}
    onPing={(id) => { void w.pingSession(id); }}
    onClose={w.closeFromPicker}
    onTrash={(id) => { void w.trashSession(id); }}
    onCancel={w.dismissOverlay}
    onPick={(l) => {
      if (l.kind === 'add') { w.startAddWorkspace(); return; }
      w.dismissOverlay();
      void w.openSession(l.kind === 'new'
        ? { kind: 'new', workspaceId: l.workspaceId }
        : { kind: 'open', id: l.sessionId });
    }} /> : null
), which === 'resume' ? { watch: w.watchPicker } : {});
