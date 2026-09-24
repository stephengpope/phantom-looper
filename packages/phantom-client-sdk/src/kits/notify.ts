// The NOTIFY kit — send_message: the agent DMs the user on Telegram, outside
// its reply, over POST /sessions/:id/notify. Built only when the global
// `telegram_enabled` is on: Telegram off means no tool.
import { tool } from 'ai';
import { z } from 'zod';
import { call, callRaw } from '../backend.js';
import { PhantomError } from '../errors.js';
import type { BuiltTools, ToolKit, ToolKitContext } from '../toolkit.js';

export const notifyToolKit: ToolKit = {
  name: 'notify',
  version: (ctx) => ctx.sessionId,
  async build(ctx: ToolKitContext): Promise<BuiltTools> {
    let settings: Record<string, { value: unknown }>;
    try { settings = await call(ctx.backend, 'GET', '/settings'); }
    catch (e) { throw new PhantomError('tool_build_failed', `could not read the settings: ${(e as Error).message}`, { cause: e }); }
    if (settings.telegram_enabled?.value !== true) return { tools: {}, mutating: [] };
    return { mutating: [], tools: {
      send_message: tool({
        description:
          'Send the user a Telegram DM — the only way to reach them outside this chat.\n\n'
          + '"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" all mean CALL '
          + 'THIS, not write it down. Markdown is rendered; name a file\'s path (/workspace/...) or put '
          + 'MEDIA:/workspace/path/to/file on its own line and it is delivered with the message.',
        inputSchema: z.object({ text: z.string().describe('The message to send.') }),
        execute: async ({ text }) => {
          const j = await callRaw(ctx.backend, 'POST', `/sessions/${encodeURIComponent(ctx.sessionId)}/notify`, { text: String(text ?? '') });
          return j.ok ? 'Message sent to the user on Telegram.' : `Could not send the message: ${j.error?.message ?? 'unknown'}`;
        },
      }),
    } };
  },
};
