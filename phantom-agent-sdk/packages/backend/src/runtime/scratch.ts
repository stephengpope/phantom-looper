// A workspace's scratch pad copied to another workspace — through the hosts,
// so the two may be anywhere (a duplicate's copy lands on whichever host it
// was placed on). Same filenames: the copy's container mounts them at the
// same /workspace/scratch/ path, so every reference in the transcript works.
import type { WorkspaceHost } from './WorkspaceHost.js';

export async function copyScratch(from: WorkspaceHost, fromId: string, to: WorkspaceHost, toId: string): Promise<void> {
  const source = from.files(fromId);
  const target = to.files(toId);
  const walk = async (rel: string): Promise<void> => {
    const entries = await source.list(rel);
    if (!entries) return;
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.kind === 'dir') { await target.mkdir(path); await walk(path); }
      else if (entry.kind === 'file') { const data = await source.read(path); if (data) await target.write(path, data); }
    }
  };
  await target.mkdir('scratch');
  await walk('scratch');
}
