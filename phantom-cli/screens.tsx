// Every overlay, in one place. An overlay is what shows on top of the chat:
// a FULL one owns the main column (every menu, the board), an INLINE one
// swaps in for the prompt zone with the conversation still above (a
// confirmation). Each is built here as a plain `Overlay` — what to draw,
// what to do when it goes — and the window shows it with `w.showOverlay`.
// Closing is one thing everywhere: `w.dismissOverlay(result)`.
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
import type { ConfigKey } from './config.js';
import type { Overlay, WindowStore } from './window.js';
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
import { DuplicateModel } from './components/DuplicateModel.js';
import { Board } from './components/Board.js';
import { Confirm } from './components/Confirm.js';
import { quiet } from './request.js';
import type { WorkspaceInfo } from './components/Launcher.js';

/** /server is the ONE screen that must work with the server down — it is
 *  where you fix the address — so it gets this api and its two keys are the
 *  two that live in the file. */
const offline: Api = async () => ({});

const full = (name: string, render: Overlay['render'], rest: Partial<Overlay> = {}): Overlay =>
  ({ size: 'full', name, render, ...rest });

// ── inline ────────────────────────────────────────────────────────────────

/** A yes/no in the prompt zone. enter = true, esc = false; anything that
 *  replaces it (another overlay, ctrl+c) answers false too — a question
 *  taken off the screen was not answered yes. `who` names an agent asking. */
export const confirmScreen = (w: WindowStore, title: string, message: string | undefined,
  who: string | undefined, resolve: (yes: boolean) => void): Overlay => ({
  size: 'inline', name: 'confirm',
  render: () => <Confirm title={title} message={message} who={who} onResult={w.dismissOverlay} />,
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
  card?: { seq: number; back: 'chat' | 'board' }): Overlay =>
  // The name says what is on screen for the Assistant's "is the board up":
  // a card opened FROM the board is still the board.
  full(card?.back === 'chat' ? 'card' : 'board', ({ width, height }) => (
    <Board store={w.boardFor(workspaceId)} width={width} height={height} isActive
      card={card?.seq}
      onOpenCard={(seq) => w.openCard(seq, 'board')}
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

/** /settings — the server's own settings; the screen's sub line says the scope. */
export const settingsScreen = (w: WindowStore): Overlay => full('settings', () => (
  <Settings key={`settings-${w.settingsVersion}`} api={w.api} configPath={w.configPath} startAt="api"
    onClose={w.dismissOverlay} />
));

/** /keys — its own screen so there is ONE place any credential is set. A
 *  saved key has to reach the app like any other setting change: the
 *  Assistant takes its Deepgram key at spawn, and the agents take theirs at
 *  build. */
export const keysScreen = (w: WindowStore): Overlay => full('keys', () => (
  <Keys key={`keys-${w.settingsVersion}`} api={w.api} onClose={w.dismissOverlay}
    onChanged={(name) => w.settingChanged(name as ConfigKey)} />
));

/** /secrets — the agent's secrets, not phantom's own credentials (/keys).
 *  The screen reads every layer itself — no session context needed. */
export const secretsScreen = (w: WindowStore): Overlay => full('secrets', () => (
  <Secrets api={w.api} onClose={w.dismissOverlay} />
));

/** /assistant — the Assistant's settings: local, offline. Device rows offer
 *  what the sidecar found; saving a boot-time key restarts it. */
export const voiceScreen = (w: WindowStore): Overlay => full('voice', () => {
  const vs = w.voice.snapshot();
  return (
    <Settings key={`voice-settings-${w.settingsVersion}`}
      api={w.api} configPath={w.configPath} startAt="local"
      title="voice" groups={['voice']}
      suggestions={{ voice_mic_device: vs.devices.mics, voice_speaker_device: vs.devices.speakers }}
      onOpenRow={(k) => { if (k === 'voice_mic_device' || k === 'voice_speaker_device') void w.voice.refreshDevices(); }}
      onLocalChange={w.settingChanged} onClose={w.dismissOverlay} />
  );
});

/** /model and /server. /model writes to the server like every other
 *  setting screen; /server gets the offline api (see above). */
export const localSettingsScreen = (w: WindowStore, which: 'model' | 'server'): Overlay => full(which, () => (
  <Settings key={`local-settings-${w.settingsVersion}`}
    api={which === 'server' ? offline : w.api} configPath={w.configPath} startAt="local"
    title={which} groups={[which]}
    onLocalChange={w.settingChanged} onClose={w.dismissOverlay} />
));

/** /presets. Applying closes the screen — the confirmation and the rebuilt
 *  agents both land in the CLI the user is back at. */
export const presetsScreen = (w: WindowStore): Overlay => full('presets', () => (
  <Presets key={`presets-${w.settingsVersion}`} api={w.api}
    onApplied={(name) => {
      w.note(`preset applied: ${name}`);
      w.settingChanged('provider' as ConfigKey);
    }}
    onClose={w.dismissOverlay} />
));

/** A duplicate's one question — which model the copy runs on (`w.duplicating`,
 *  read fresh: a settings change moves the "keep current" row's label). esc
 *  drops it: no copy is made. */
export const duplicateModelScreen = (w: WindowStore): Overlay =>
  full('duplicateModel', () => (
    w.duplicating ? <DuplicateModel presets={w.duplicating.presets} current={w.duplicating.current}
      onPick={(presetId) => { void w.finishDuplicate(presetId); }}
      onCancel={w.dismissOverlay} /> : null
  ), { onDismiss: () => { w.duplicating = null; } });

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
export const tasksScreen = (w: WindowStore): Overlay => full('tasks', () => (
  w.tasks ? <Tasks view={w.tasks} notice={w.tasksNotice}
    onKill={(sid, cmd) => { void w.killTask(sid, cmd); }}
    onCancel={w.dismissOverlay} /> : null
), { poll: () => { void w.refreshTasks().catch(quiet('refresh tasks')); } });

/** /resume (sessions) and /workspace (workspaces) — one launcher, two
 *  modes. /resume re-reads on the poll while up: its rows spin and its
 *  locks lapse while you watch. The refresh swaps rows in place, so the
 *  cursor, the notice line and an armed [t] all stay put. */
export const pickerScreen = (w: WindowStore, which: 'workspace' | 'resume'): Overlay => full(which, () => (
  w.picker ? <Launcher
    mode={which === 'resume' ? 'sessions' : 'workspaces'}
    workspaces={w.picker.workspaces} sessions={w.picker.sessions} total={w.picker.total}
    showSupervised={w.showSupervised}
    onToggleSupervised={() => w.toggleSupervised()}
    busy={(id) => w.sessions.get(id)?.busy ?? false}
    loaded={(id) => w.sessions.has(id)}
    clientId={w.clientId}
    notice={w.pickerNotice}
    onNearEnd={which === 'resume' ? () => { void w.morePicker(); } : undefined}
    onEdit={(id) => w.editWorkspace(id)}
    onDuplicate={(id) => { void w.startDuplicate(id); }}
    onPin={(id) => { void w.pinFromPicker(id); }}
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
), which === 'resume' ? { poll: () => { void w.refreshPicker().catch(quiet('refresh the session list')); } } : {});
