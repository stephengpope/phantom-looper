// Environment facts — the one dynamic line of the coding prompt's
// environment block: "Debian GNU/Linux 13 (trixie), arm64 · Node v24.5.0 ·
// Python 3.13.5", read from the workspace (fs) image itself so nobody
// maintains a version string by hand.
//
// Unlike system skills this needs EXECUTION (node/python only speak when
// run), so the probe runs the image once: a throwaway no-network container
// prints keyed lines and exits. Cached by image ID — the facts ship IN the
// image, so the ID is the content. Every failure — image not pulled yet,
// docker down, an image with no sh — is an EMPTY line, logged, never an
// error: the prompt's static environment text stands on its own.
import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { logger, errStr } from './log.js';

const log = logger('environment');

const PROBE = '. /etc/os-release 2>/dev/null; echo "os=${PRETTY_NAME:-}";'
  + ' echo "arch=$(uname -m)";'
  + ' echo "node=$(node --version 2>/dev/null)";'
  + ' echo "python=$(python3 --version 2>/dev/null)"';
const PROBE_TIMEOUT_MS = 30_000;

const cache = new Map<string, string>();

/** The keyed probe output as the prompt line; '' when nothing usable. */
export function composeFacts(raw: string): string {
  const kv = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const os = kv.get('os') || 'Linux';
  const arch = kv.get('arch') ?? '';
  if (!arch) return ''; // uname failed = the probe never really ran
  const parts = [`${os}, ${arch}`];
  const node = kv.get('node');
  if (node) parts.push(`Node ${node}`);
  const python = kv.get('python');
  if (python) parts.push(python.startsWith('Python ') ? python : `Python ${python}`);
  return parts.join(' · ');
}

/** The image's facts line, cached by image ID. Never throws. */
export async function environmentFacts(docker: Docker, image: string): Promise<string> {
  let id: string;
  try {
    id = (await docker.getImage(image).inspect()).Id;
  } catch (e) {
    log.info({ image, err: errStr(e) }, 'env facts: image not inspectable — empty line');
    return '';
  }
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  let facts = '';
  try {
    facts = composeFacts(await probe(docker, image));
  } catch (e) {
    log.warn({ image, err: errStr(e) }, 'env facts: probe failed — empty line');
  }
  cache.set(id, facts);
  return facts;
}

async function probe(docker: Docker, image: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image, Cmd: ['sh', '-c', PROBE], Tty: false,
    HostConfig: { NetworkMode: 'none' },
  });
  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const out: Buffer[] = [];
    const outSink = new PassThrough(); const errSink = new PassThrough();
    outSink.on('data', (d: Buffer) => { out.push(d); });
    errSink.on('data', () => {});
    docker.modem.demuxStream(stream, outSink, errSink);
    await container.start();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
      container.wait().then(() => { clearTimeout(t); resolve(); },
        (e: Error) => { clearTimeout(t); reject(e); });
    });
    return Buffer.concat(out).toString('utf8');
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}
