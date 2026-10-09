// The session host entrypoint — the same image as the API, this process
// instead of it: a box with Docker and a workspace volume that connects OUT
// to a backend and runs its workspaces (phantom-agent-sdk SessionHost).
// Configured by the environment alone (session-host/docker-compose.yml).
import { SessionHost, logger, errStr } from '@phantom-agent-sdk/backend';

const log = logger('boot');

async function main() {
  const host = SessionHost.fromEnv();
  const stop = (signal: string) => {
    log.info({ signal }, 'session host stopping — the link closes, what runs keeps running');
    host.stop().then(() => process.exit(0), (error) => { log.error({ err: errStr(error) }, 'stop failed'); process.exit(1); });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await host.start();
  log.info(host.status(), 'session host up');
}

main().catch((error) => { log.error({ err: errStr(error) }, 'session host failed to start'); process.exit(1); });
