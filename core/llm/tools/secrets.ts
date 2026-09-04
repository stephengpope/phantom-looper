/**
 * The SECRETS kit — `secret_list`, `secret_get`, the coding agent's window
 * onto the secrets the user stored (over the /secrets routes). Read-only by
 * design: adding and deleting are the cli's, so there is nothing for a
 * readonly preset to drop and the kit works unchanged in plan mode.
 *
 * Bound to the session's WORKSPACE at build time (the kanban read's pattern):
 * the workspace's own secrets win a name collision with global ones, and the
 * server resolves that chain from the ?workspace= these tools always send.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

export interface SecretToolsConfig {
  baseUrl: string;
  apiKey: string;
  /** The session's workspace — its secrets shadow global ones by name. */
  workspaceId: string;
  fetch?: typeof fetch;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export function secretTools(cfg: SecretToolsConfig): Record<string, Tool> {
  const f = cfg.fetch ?? fetch;
  const api = async <T>(p: string): Promise<Envelope<T>> => {
    const r = await f(`${cfg.baseUrl}${p}?workspace=${encodeURIComponent(cfg.workspaceId)}`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    return r.json() as Promise<Envelope<T>>;
  };

  return {
    secret_list: tool({
      description: 'The stored secrets — names and descriptions, never values. The index in your ' +
        'instructions was written when this session started; use this when a secret might have ' +
        'been added since, or the one you expected is missing.',
      inputSchema: z.object({}),
      execute: async () => {
        const r = await api<{ secrets: unknown }>('/secrets');
        return r.ok ? { secrets: r.data.secrets } : r;
      },
    }),

    secret_get: tool({
      description: 'One stored secret\'s value, by name — tokens and credentials the user saved ' +
        'for your use in this project (API keys, service tokens). Use the real value it returns ' +
        'in commands, config and .env files; never invent a placeholder when a stored secret ' +
        'covers the need. The names are in your instructions\' secrets index, or secret_list.',
      inputSchema: z.object({
        name: z.string().describe('the secret\'s name, from the index in your instructions or secret_list'),
      }),
      execute: async ({ name }) => api(`/secrets/${encodeURIComponent(name)}`),
    }),
  };
}
