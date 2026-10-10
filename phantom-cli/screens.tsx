// Every overlay, in one place. An overlay is a screen on top of the chat: a
// FULL one owns the main column (every menu, the board), a THIRD takes the
// bottom third with the conversation still above (the glance lists). Each
// is built here as a plain `Overlay` — what to draw, what to do when it goes
// — and the window shows it with `store.showOverlay`. Closing is one thing
// everywhere: `store.dismissOverlay(result)`. The one thing that goes ON TOP of
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
import { NewProject, type NewProjectRequest } from './components/NewProject.js';
import { ProjectSettings } from './components/ProjectSettings.js';
import { SessionSwitcher } from './components/SessionSwitcher.js';
import { Keys } from './components/Keys.js';
import { Tasks } from './components/Tasks.js';
import { Archived } from './components/Archived.js';
import { Secrets } from './components/Secrets.js';
import { Presets } from './components/Presets.js';
import { Board } from './components/Board.js';
import { Confirm, CONFIRM_ROWS } from './components/Confirm.js';
import { quiet } from './request.js';
import type { ProjectInfo } from './components/Launcher.js';

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
export const boardScreen = (store: WindowStore, projectId: string,
  card?: { number: number; back: 'chat' | 'board' }): Overlay =>
  // The name says what is on screen for the Assistant's "is the board up":
  // a card opened FROM the board is still the board.
  full(card?.back === 'chat' ? 'card' : 'board', ({ width, height }) => (
    <Board store={store.boardFor(projectId)} width={width} height={height} isActive
      card={card?.number}
      confirm={(title, message) => store.confirm(title, message)}
      onOpenCard={(number) => store.openCard(number, 'board')}
      onCloseCard={() => { if (card?.back === 'board') store.openBoard(); else store.dismissOverlay(); }}
      onClose={store.dismissOverlay}
      // The card editor's Session row: back to chat, then the one open
      // path — already loaded switches, otherwise it opens (read-only
      // while the looper holds it, like /resume).
      onOpenSession={(id) => { store.dismissOverlay(); void store.openSession({ action: 'open', id }); }}
      // [v]: the archive. Off the board first, so a failed fetch's note
      // lands where you can read it.
      onArchived={() => { store.dismissOverlay(); void store.openArchived(projectId); }} />
  ));

// ── the menus ─────────────────────────────────────────────────────────────

/** ctrl+n: the sessions open in this window. */
export const switcherScreen = (store: WindowStore): Overlay => full('sessions', () => (
  <SessionSwitcher
    sessions={store.sessions.list()} activeId={store.sessions.activeId} projects={store.projectRows}
    onPick={(id) => { store.dismissOverlay(); store.switchTo(id); }}
    onCancel={store.dismissOverlay} />
));

/** /settings — every server setting plus this machine's audio rows;
 *  /assistant opens it at the Assistant's group. Device rows offer what the voice
 *  sidecar found; saving a boot-time key restarts it. */
export const settingsScreen = (store: WindowStore, startAt?: 'assistant'): Overlay => full('settings', () => {
  const voiceSnapshot = store.voice.snapshot();
  return (
    <Settings key={`settings-${store.settingsVersion}`} api={store.api} configPath={store.configPath} title="settings"
      rows={{ server: true, local: 'voice' }} startAt={startAt}
      suggestions={{ voice_mic_device: voiceSnapshot.devices.mics, voice_speaker_device: voiceSnapshot.devices.speakers }}
      onOpenRow={(key) => { if (key === 'voice_mic_device' || key === 'voice_speaker_device') void store.voice.refreshDevices(); }}
      onChange={store.settingChanged} onClose={store.dismissOverlay} />
  );
});

/** /keys — its own screen so there is ONE place any credential is set. A
 *  saved key has to reach the app like any other setting change: the
 *  Assistant takes its Deepgram key at spawn, and the agents take theirs at
 *  build. */
export const keysScreen = (store: WindowStore): Overlay => full('keys', () => (
  <Keys key={`keys-${store.settingsVersion}`} api={store.api} onClose={store.dismissOverlay}
    onChanged={store.settingChanged} />
));

/** /secrets — the agent's secrets, not phantom's own credentials (/keys).
 *  The screen reads every layer itself — no session context needed. */
export const secretsScreen = (store: WindowStore): Overlay => full('secrets', () => (
  <Secrets api={store.api} onClose={store.dismissOverlay} />
));

/** /server — this machine's connection rows, on the offline api (see above). */
export const serverScreen = (store: WindowStore): Overlay => full('server', () => (
  <Settings key={`server-settings-${store.settingsVersion}`}
    api={offline} configPath={store.configPath} title="server" rows={{ local: 'server' }}
    onChange={store.settingChanged} onClose={store.dismissOverlay} />
));

/** /presets. Applying closes the screen — the confirmation and the rebuilt
 *  agents both land in the CLI the user is back at. */
export const presetsScreen = (store: WindowStore): Overlay => full('presets', () => (
  <Presets key={`presets-${store.settingsVersion}`} api={store.api}
    confirm={(title, message) => store.confirm(title, message)}
    onApplied={(name) => {
      store.note(`preset applied: ${name}`);
      store.settingChanged('provider');
    }}
    onClose={store.dismissOverlay} />
));

/** `e` on a /project row: that project's settings. Closing goes back to
 *  the list it was opened from, refreshed — a rename there has to show up.
 *  A write is a settings change like any other (the coding agent's model
 *  among them): every open session re-reads its config, as after /settings. */
export const projectSettingsScreen = (store: WindowStore, project: ProjectInfo): Overlay =>
  full('projectSettings', () => (
    <ProjectSettings key={`project-settings-${store.settingsVersion}`}
      api={store.api} project={project}
      onClose={() => { void store.openPicker('project'); }}
      onChanged={() => { store.settingChanged(); void store.refreshPicker().catch(quiet('refresh the session list')); }} />
  ));

/** The add-a-project form. A rejected submit stays on the form with the
 *  server's words (`store.addError`, read fresh each render — the form must NOT
 *  be re-shown, that would remount it and lose what was typed). */
export const addProjectScreen = (store: WindowStore): Overlay => full('addProject', () => (
  <NewProject api={store.api} error={store.addError}
    onCancel={store.dismissOverlay}
    onSubmit={(req: NewProjectRequest) => { void store.addProject(req); }} />
));

/** /archived — the project's archived cards, paged like /resume. */
export const archivedScreen = (store: WindowStore, projectId: string): Overlay => full('archived', () => (
  <Archived cards={store.archived} notice={store.archivedNotice}
    onNearEnd={() => { void store.moreArchived(projectId); }}
    total={store.archivedTotal}
    // The solo editor renders from the board store, which never holds
    // archived cards on its own — seat this one first.
    onOpen={(card) => store.openArchivedCard(projectId, card)}
    onRestore={(card) => { void store.restoreCard(projectId, card); }}
    onCancel={store.dismissOverlay} />
));

/** /tasks — what is running in the session's container. Re-read on the
 *  poll while up: rows come and go on their own. */
export const tasksScreen = (store: WindowStore): Overlay => third('tasks', () => (
  store.tasks ? <Tasks view={store.tasks} notice={store.tasksNotice}
    onKill={(sid, cmd) => { void store.killTask(sid, cmd); }}
    onCancel={store.dismissOverlay} /> : null
), { poll: () => { void store.refreshTasks().catch(quiet('refresh tasks')); } });

/** /resume (sessions) and /project (projects) — one launcher, two
 *  modes. /resume follows the session list feed while up: a row moving
 *  anywhere re-reads the list, so its rows spin and its locks lapse as they
 *  happen. The refresh swaps rows in place, so the cursor and the notice
 *  line stay put. */
export const pickerScreen = (store: WindowStore, which: 'project' | 'resume'): Overlay => full(which, () => (
  store.picker ? <Launcher
    mode={which === 'resume' ? 'sessions' : 'projects'}
    projects={store.projectRows} sessions={store.picker.sessions} total={store.picker.total}
    contextWindowOf={(provider, model) => store.contextWindowOf(provider, model)}
    showBackground={store.showBackground}
    onToggleBackground={() => store.toggleBackground()}
    query={store.pickerQuery} rowsQuery={store.picker.query}
    onQuery={which === 'resume' ? (query) => store.setPickerQuery(query) : undefined}
    projectId={store.pickerProject}
    onCycleProject={which === 'resume' ? (dir) => store.cyclePickerProject(dir) : undefined}
    busy={(id) => store.sessions.get(id)?.busy ?? false}
    loaded={(id) => store.sessions.has(id)}
    clientId={store.clientId}
    notice={store.pickerNotice}
    onNearEnd={which === 'resume' ? () => { void store.morePicker(); } : undefined}
    onEdit={(id) => store.editProject(id)}
    onDuplicate={(id) => { void store.duplicateFromPicker(id); }}
    onPin={(id) => { void store.pinFromPicker(id); }}
    onPing={(id) => { void store.pingSession(id); }}
    onClose={store.closeFromPicker}
    onTrash={(id) => { void store.trashSession(id); }}
    onCancel={store.dismissOverlay}
    onPick={(launch) => {
      if (launch.action === 'add') { store.startAddProject(); return; }
      store.dismissOverlay();
      void store.openSession(launch.action === 'new'
        ? { action: 'new', projectId: launch.projectId }
        : { action: 'open', id: launch.sessionId });
    }} /> : null
), which === 'resume' ? { watch: store.watchPicker } : {});
