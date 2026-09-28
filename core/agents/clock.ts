// The builder's clock for a prompt's "Current date" line: the `timezone`
// setting, read at the workspace's scope — the same setting every other
// date in the system is read in.
import type { PhantomBackend } from 'phantom-client-sdk';
import { Clock } from '../clock.js';

export async function clockFor(backend: PhantomBackend, workspaceId: string): Promise<Clock> {
  const settings = await backend.call<Record<string, { value: unknown }>>('GET', `/settings?workspace=${encodeURIComponent(workspaceId)}`);
  const tz = settings.timezone?.value;
  return new Clock(typeof tz === 'string' && tz ? tz : 'UTC');
}
