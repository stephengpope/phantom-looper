// Boot: PhantomBackend.create(config) builds the backend — env, database,
// migrations, every service — and backend.start() runs it: the API, the git
// service, the loops, then this app's engines (config.onStart): the looper,
// the cron scheduler, the Telegram bot, the digest, the upgrade check. The
// app reaches the backend through the config and its public objects only.
import { PhantomBackend, telegramChannel, sidecarApply, logger, errStr, type PhantomBackendConfig } from '@phantom-agent-sdk/backend';
import { BackendClient } from '@phantom-agent-sdk/client';
import { GIT_CLIENT_ID } from '@phantom-agent-sdk/backend/git';
import { config as registrations } from './config.js';
import { CodingAgent } from '../phantom-looper/agents/coding.js';
import { writeTitle } from './sessionTitle.js';
import { writeCommitMessage } from './git/commitMessage.js';
import { toCodingAgent } from '../phantom-looper/prompts/autoPush/wiring.js';
import { Looper } from './looper/Looper.js';
import { CardAutomation } from './looper/CardAutomation.js';
import { boardTools } from './looper/boardTools.js';
import { TelegramAssistantBot } from './telegram/TelegramAssistantBot.js';
import { SessionDigest } from './notifications/digest.js';
import { menuFor } from './telegram/commands.js';

const log = logger('boot');

async function main() {
  // What this app's engines hold while the backend runs; set in onStart,
  // read by the routes and stopped in onStop.
  let looper: Looper;
  let telegram: TelegramAssistantBot;
  let digest: SessionDigest;

  // This app's deployment: the two images a release tag means, the updater
  // sidecar that replaces the stack (updater/apply.sh), and the one reason
  // a restart waits — a card run mid-round. The SDK runs the update
  // (/api/update, /api/system/*); this is all it needs from the app. No
  // sidecar (UPDATE_TRIGGER_DIR unset): no strategy, updates refuse.
  const triggerDir = process.env.UPDATE_TRIGGER_DIR;
  const apiImage = process.env.API_IMAGE || 'ghcr.io/stephengpope/phantom-backend';
  const sessionImage = process.env.SESSION_IMAGE || 'ghcr.io/stephengpope/phantom-backend-session';
  const deployment: PhantomBackendConfig['deployment'] = triggerDir ? {
    images: (tag) => [{ name: 'api', ref: `${apiImage}:${tag}` }, { name: 'session', ref: `${sessionImage}:${tag}` }],
    apply: sidecarApply({ triggerDir }),
    guard: () => {
      const loops = looper?.runningCount() ?? 0;
      if (!loops) return null;
      return loops === 1 ? '1 card has a round in flight — restarting now would interrupt it (it resumes after the restart)'
        : `${loops} cards have a round in flight — restarting now would interrupt them (they resume after the restart)`;
    },
  } : undefined;

  const config: PhantomBackendConfig = {
    ...registrations,
    ...(deployment ? { deployment } : {}),
    health: () => ({ loops_running: looper?.runningCount() ?? 0 }),
    // The looper's two switches on a card: the app's table, carried on every
    // card the SDK answers (the door), and the two tools that flip them.
    cardFields: {
      schema: CardAutomation.schema,
      read: (cardIds) => cardAutomation().read(cardIds),
      write: (cardId, fields, transaction) => cardAutomation().write(cardId, fields, transaction),
      board: (project) => cardAutomation().defaults(project),
    },
    tools: boardTools,
    // Crons: the SDK schedules and runs them, each as its owner; a prompt
    // cron runs the coding agent, as a cli window would.
    crons: { agent: CodingAgent },
    // The bot's command menu — the global default, and the service role's chat's
    // for its mode (each chat's own is set when its mode changes; the bot
    // exists before the SDK registers the webhook, which onStart's reconcile
    // is what asks for).
    telegramCommandMenu: async () => {
      const own = await backend.telegramBot.authorizedUser();
      return { global: menuFor('assistant'), ...(own ? { forChat: menuFor((await telegram.state.read(own)).mode) } : {}) };
    },

    // The backend's git, with this app's parts: the conflict fixer is the
    // session's own coding agent; the commit message rides the ASSISTANT's
    // model — the small-fast slot; writing one subject line from a diff is
    // not work for the model doing the engineering (a config that cannot
    // build THROWS and the sync fails with that reason — no file-name
    // fallback anywhere); the words the coder reads after a sync are its prompts.
    git: {
      resolveConflict: async (session, _project, _dir, ctx) => {
        // The SAME client id the sync holds the session under — a holder may
        // re-take its own hold; any other id would find the session locked by us.
        let agent: CodingAgent | undefined;
        try {
          agent = await CodingAgent.resumeSession(gitClient(), {
            onError: (error) => log.warn({ session: session.id, code: error.code, err: error.message }, 'conflict turn error'),
            onNotice: (notice) => log.info({ session: session.id }, notice.text),
          }, session.id);
          // Resolving means writing files: never in plan mode.
          await backend.sessions.setPlanMode(session.id, false);
          const result = await agent.sendMessage(toCodingAgent.resolveConflict(ctx.branch, ctx.baseBranch, ctx.files, ctx.arrived));
          return result?.outcome === 'done';
        } catch (error) {
          if ((error as { code?: string }).code === 'session_locked') log.warn({ session: session.id }, 'conflict turn could not open the session — it is busy');
          else log.error({ session: session.id, err: errStr(error) }, 'conflict turn failed');
          return false;
        } finally {
          await agent?.close().catch(() => {});
        }
      },
      writeCommitMessage: (input, report) => writeCommitMessage(oneShotDeps(), input, report),
      syncNote: (project, result, opts) => {
        if (result.outcome === 'ok') return toCodingAgent.syncSummary(project.baseBranch, opts.landOnBase, result.arrived ?? [], result.files ?? []);
        if (result.outcome === 'blocked' && result.files?.length) return toCodingAgent.syncConflict(project.baseBranch, result.arrived ?? [], result.files);
        return null;
      },
    },
    // The session title's model call rides the assistant's model too.
    writeTitle: (sessionId, context) => writeTitle(oneShotDeps())(sessionId, context),

    onStart: async (backend) => {
      const { settings } = backend;

      // The looper — a client of this backend's own API (the same tools every
      // client runs), so it starts once the routes answer. Event-driven: every
      // card write reaches it over the board bus; start() is ONE recovery
      // sweep, not a poll.
      looper = new Looper(backend, cardAutomation());
      looper.start();

      // The Telegram bot's behaviour — a client of this app like the looper.
      // Reconcile at boot re-registers a stale webhook and pushes the command menu.
      telegram = new TelegramAssistantBot(backend, () => looper.runningCount());
      // The agents' send_message and the digest go out through the bot.
      backend.notifications.addChannel({
        name: 'telegram',
        send: (text, context) => context?.sessionId ? telegram.notify(context.sessionId, text) : telegramChannel(settings).send(text),
      });
      void telegram.reconcile();

      // Session idle digest — a periodic notification listing sessions that
      // finished. Standalone timer, no dependency on the engines' turn machinery.
      digest = new SessionDigest(backend, oneShotDeps());
      void digest.start();

      // Upgrade checker — periodic GitHub release check, notification via Telegram.
      // Waits one interval before the first check: the server may have just
      // restarted from an upgrade (checking immediately would find it current and
      // waste a GitHub API call). The interval is a setting read per tick, so a
      // change takes effect without a restart. 0 disables the check.
      void (async () => {
        while (!backend.stopped) {
          const intervalMs = await settings.resolve('update_check_interval_ms').catch(() => 86_400_000);
          if (Number(intervalMs) <= 0) { await new Promise((wake) => setTimeout(wake, 60_000)); continue; }
          await new Promise((wake) => setTimeout(wake, Number(intervalMs)));
          if (backend.stopped) break;
          await telegram.upgradeChecker.check().catch((error) => log.warn({ err: errStr(error) }, 'upgrade check failed'));
        }
      })();
    },

    onStop: async () => {
      looper?.stop();
      digest?.stop();
    },
  };

  const backend = await PhantomBackend.create(config);
  // The looper's card table, on the backend's connection — made once the
  // backend exists; the SDK asks for card fields only after start.
  let automation: CardAutomation | undefined;
  const cardAutomation = () => (automation ??= new CardAutomation(backend.database.drizzle, backend.settings));
  // ONE client for this app's own model calls (the conflict fixer, the commit
  // message, the title, the digest): the git sync's identity, so a conflict
  // turn re-takes the sync's own hold.
  let client: BackendClient | undefined;
  const gitClient = () => (client ??= new BackendClient({ url: backend.loopback.url, credential: { serviceRoleKey: backend.env.serviceRoleKey }, clientId: GIT_CLIENT_ID, label: 'git sync' }));
  const oneShotDeps = () => ({ agentConfig: backend.agentConfig, client: gitClient() });

  const shutdown = async () => { await backend.stop(); process.exit(0); };
  await backend.start();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => { log.error({ err: errStr(error) }, 'boot failed'); process.exit(1); });
