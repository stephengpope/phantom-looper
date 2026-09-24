// The SECRETS kit — secret_list, secret_get: the stored secrets, over the
// /secrets routes. Read-only by design. Bound to the session's workspace:
// its secrets shadow global ones by name.
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { callRaw } from '../backend.js';
import type { BuiltTools, ToolKit, ToolKitContext } from '../toolkit.js';

export const secretsToolKit: ToolKit = {
  name: 'secrets',
  version: (ctx) => ctx.workspaceId,
  build(ctx: ToolKitContext): Promise<BuiltTools> {
    const ws = `?workspace=${encodeURIComponent(ctx.workspaceId)}`;
    return Promise.resolve({ mutating: [], tools: {
      secret_list: tool({
        description: 'The stored secrets — names and descriptions, never values. The index in your ' +
          'instructions was written when this session started; use this when a secret might have ' +
          'been added since, or the one you expected is missing.',
        inputSchema: z.object({}),
        execute: async () => {
          const r = await callRaw<{ secrets: unknown }>(ctx.backend, 'GET', `/secrets${ws}`);
          return r.ok ? { secrets: r.data?.secrets } : r;
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
        execute: ({ name }) => callRaw(ctx.backend, 'GET', `/secrets/${encodeURIComponent(name)}${ws}`),
      }),
    } });
  },
};
