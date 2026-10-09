// The session runner entrypoint — the same image as the API, this process
// instead of it: a box with Docker and a workspace volume that connects OUT
// to a backend and runs its workspaces (phantom-agent-sdk SessionRunner).
// Configured by the environment alone (session-runner/docker-compose.yml).
import { SessionRunner, logger, errStr } from '@phantom-agent-sdk/backend';

const log = logger('boot');

async function main() {
  const host = SessionRunner.fromEnv();
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
