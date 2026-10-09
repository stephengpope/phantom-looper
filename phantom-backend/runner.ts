// The session runner entrypoint — the same image as the API, this process
// instead of it: a box with Docker and a workspace volume that connects OUT
// to a backend and runs its workspaces (phantom-agent-sdk SessionRunner).
// Configured by the environment alone (session-runner/docker-compose.yml).
import { SessionRunner, logger, errStr } from '@phantom-agent-sdk/backend';
import { CodingAgent } from '../phantom-looper/agents/coding.js';
import { SupervisorAgent } from '../phantom-looper/agents/supervisor.js';
import { AssistantAgent } from '../phantom-looper/agents/assistant.js';
import { codingAgentCardKit, supervisorCardKit, type CardRunCard, type LoopColumn } from './looper/cardRunTools.js';

const log = logger('boot');

async function main() {
  // The turns this box can drive (a hand-off from a cli, a cron or a card
  // run placed here): this app's three agents, by type — the classes a cli
  // window and the API's engines run — and the card run's kits, which a
  // placed looper turn asks for by name with its card.
  const host = SessionRunner.fromEnv(process.env, { agents: {
    coding: { agent: CodingAgent, kits: { 'card-run': (args) => codingAgentCardKit(args.card as CardRunCard) } },
    supervisor: { agent: SupervisorAgent, kits: { 'card-run': (args) => supervisorCardKit(args.card as CardRunCard, args.column as LoopColumn) } },
    assistant: { agent: AssistantAgent },
  } });
  const stop = (signal: string) => {
    log.info({ signal }, 'session runner stopping — the link closes, what runs keeps running');
    host.stop().then(() => process.exit(0), (error) => { log.error({ err: errStr(error) }, 'stop failed'); process.exit(1); });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await host.start();
  log.info(host.status(), 'session runner up');
}

main().catch((error) => { log.error({ err: errStr(error) }, 'session runner failed to start'); process.exit(1); });
