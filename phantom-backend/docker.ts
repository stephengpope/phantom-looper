// Docker client. The adapter speaks the API SOCKET, never the docker CLI —
// measured ~35ms per exec against ~200ms of CLI startup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';

export function makeDocker(): Docker {
  if (process.env.DOCKER_HOST) return new Docker();
  for (const p of ['/var/run/docker.sock', path.join(os.homedir(), '.docker/run/docker.sock')]) {
    if (fs.existsSync(p)) return new Docker({ socketPath: p });
  }
  return new Docker(); // dockerode's own default; fails loudly at first use
}
