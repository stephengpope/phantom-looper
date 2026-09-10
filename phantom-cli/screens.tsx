// Every menu screen, in one place. A menu is a FULL SCREEN: while one is up
// it owns the main column — the chat, its prompt and its toolbar are not
// mounted (App.tsx's one rule: anything that is not the chat takes the whole
// column, the same rule the board always had). Each screen is built on the
// same Screen frame (components/Screen.tsx) and closes the same way:
// `w.closeScreen()`.
//
// Adding a screen: add its name to the `Menu` union (window.ts), a case here,
// and the slash command that opens it (window.ts's runCommand). There is no
// fourth place.
//
// The screens draw from the window store, which also owns their data
// (fetch-first: a screen opens only once its rows have landed, so a dead
// server leaves you on the chat with a note). The few things the store does
// not hold — the api, the config path, this window's lock id — come in as
// props from App.
import type { Api } from './request.js';
import type { ConfigKey } from './config.js';
import type { WindowStore } from './window.js';
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
import { quiet } from './request.js';

/** /server is the ONE screen that must work with the server down — it is
 *  where you fix the address — so it gets this api and its two keys are the
 *  two that live in the file. */
const offline: Api = async () => ({});

export function MenuScreen({ w, api, configPath, clientId }: {
  w: WindowStore;
  api: Api;
  configPath?: string;
  clientId: string;
}) {
  const close = w.closeScreen;
  const session = w.sessions.active();
  switch (w.screen) {
    case 'sessions':
      return (
        <SessionSwitcher
          sessions={w.sessions.list()} activeId={session?.id ?? ''} workspaces={w.workspaceRows}
          onPick={(id) => { w.closeScreen(); w.switchTo(id); }}
          onCancel={close}
        />
      );
    case 'settings':
      // The server's own settings; the screen's sub line says the scope.
      return <Settings api={api} configPath={configPath} startAt="api" onClose={close} />;
    case 'keys':
      // Its own screen so there is ONE place any credential is set — not
      // because these are a different kind of thing any more. A saved key
      // has to reach the app like any other setting change: the Assistant
      // takes its Deepgram key at spawn, and the agents take theirs at
      // build.
      return <Keys api={api} onClose={close}
        onChanged={(name) => w.settingChanged(name as ConfigKey)} />;
    case 'secrets':
      // The agent's secrets, not phantom's own credentials (/keys). The
      // screen reads every layer itself — no session context needed.
      return <Secrets api={api} onClose={close} />;
    case 'workspaceSettings':
      if (!w.editing) return null;
      return (
        <WorkspaceSettings
          api={api} workspace={w.editing}
          // Back to the list it was opened from, refreshed — a rename there
          // has to show up here.
          onClose={() => { void w.closeWorkspaceSettings(); }}
          onChanged={() => { void w.refreshPicker().catch(quiet('refresh the session list')); }}
        />
      );
    case 'voice': {
      // The Assistant's settings — local, offline. Device rows offer what
      // the sidecar found; saving a boot-time key restarts it.
      const vs = w.voice.snapshot();
      return (
        <Settings api={api} configPath={configPath} startAt="local"
          title="voice" groups={['voice']}
          suggestions={{ voice_mic_device: vs.devices.mics, voice_speaker_device: vs.devices.speakers }}
          onOpenRow={(k) => { if (k === 'voice_mic_device' || k === 'voice_speaker_device') void w.voice.refreshDevices(); }}
          onLocalChange={w.settingChanged} onClose={close} />
      );
    }
    case 'model':
    case 'server':
      // /model writes to the server like every other setting screen; /server
      // gets the offline api (see above).
      return (
        <Settings api={w.screen === 'server' ? offline : api} configPath={configPath} startAt="local"
          title={w.screen} groups={[w.screen === 'model' ? 'model' : 'server']}
          onLocalChange={w.settingChanged} onClose={close} />
      );
    case 'presets':
      return (
        <Presets api={api}
          // Applying closes the screen — the confirmation and the rebuilt
          // agents both land in the CLI the user is back at.
          onApplied={(name) => {
            w.note(`preset applied: ${name}`);
            w.settingChanged('provider' as ConfigKey);
          }}
          onClose={close} />
      );
    case 'duplicateModel':
      if (!w.duplicating) return null;
      return (
        <DuplicateModel
          presets={w.duplicating.presets}
          current={w.duplicating.current}
          onPick={(presetId) => { void w.finishDuplicate(presetId); }}
          onCancel={() => w.cancelDuplicate()} />
      );
    case 'addWorkspace':
      return (
        <NewWorkspace
          api={api}
          error={w.addError}
          onCancel={close}
          onSubmit={(req: NewWorkspaceRequest) => { void w.addWorkspace(req); }}
        />
      );
    case 'archived':
      if (!session) return null;
      return (
        <Archived cards={w.archived} notice={w.archivedNotice}
          onNearEnd={() => { void w.moreArchived(session.workspaceId); }}
          total={w.archivedTotal}
          // The solo editor renders from the store, which never holds
          // archived cards on its own — seat this one first.
          onOpen={(t) => w.openArchivedCard(session.workspaceId, t)}
          onRestore={(t) => { void w.restoreCard(session.workspaceId, t); }}
          onCancel={close} />
      );
    case 'tasks':
      if (!w.tasks) return null;
      return (
        <Tasks view={w.tasks} notice={w.tasksNotice}
          onKill={(sid, cmd) => { void w.killTask(sid, cmd); }}
          onCancel={close} />
      );
    case 'workspace':
    case 'resume':
      if (!w.picker) return null;
      return (
        <Launcher
          mode={w.screen === 'resume' ? 'sessions' : 'workspaces'}
          workspaces={w.picker.workspaces} sessions={w.picker.sessions} total={w.picker.total}
          showSupervised={w.showSupervised}
          onToggleSupervised={() => w.toggleSupervised()}
          busy={(id) => w.sessions.get(id)?.busy ?? false}
          loaded={(id) => w.sessions.has(id)}
          clientId={clientId}
          notice={w.pickerNotice}
          onNearEnd={w.screen === 'resume' ? () => { void w.morePicker(); } : undefined}
          onEdit={(id) => w.editWorkspace(id)}
          onDuplicate={(id) => { void w.startDuplicate(id); }}
          onStar={(id) => { void w.starFromPicker(id); }}
          onClose={w.closeFromPicker}
          onTrash={(id) => { void w.trashSession(id); }}
          onCancel={close}
          onPick={(l) => {
            if (l.kind === 'add') { w.startAddWorkspace(); return; }
            w.closeScreen();
            void w.openSession(l.kind === 'new'
              ? { kind: 'new', workspaceId: l.workspaceId }
              : { kind: 'open', id: l.sessionId });
          }}
        />
      );
    default:
      return null;
  }
}
