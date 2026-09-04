// The `send_message` tool — the agent DMs the user on Telegram, deliberately,
// outside its streamed reply. Ported from ../shockwave (agent-core/sendMessage.ts):
// same name, same description verbatim, one `text` parameter, no delivery-mode
// argument (how it is delivered is the telegram_reply_mode setting, read at the
// delivery end — the agent gets no say, by design).
//
// Injected into a telegram coding turn via runCodingTurn's extraTools, so it
// exists only where there is a user to DM; its description reaches every session
// including old ones (a tool description is not the frozen prompt). `send` is the
// host's delivery, closed over the client and chat.

import { tool, type Tool } from 'ai';
import { z } from 'zod';

export function sendMessageTool(send: (text: string) => Promise<{ ok: boolean; error?: string }>): Record<string, Tool> {
  return {
    send_message: tool({
      description:
        'Send the user a Telegram DM — the only way to reach them outside this chat.\n\n'
        + '"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" all mean CALL '
        + 'THIS, not write it down.',
      inputSchema: z.object({
        text: z.string().describe('The message to send.'),
      }),
      execute: async ({ text }) => {
        try {
          const r = await send(String(text ?? ''));
          return r.ok ? 'Message sent to the user on Telegram.' : (r.error || 'Could not send the message.');
        } catch (e) {
          return 'Could not send the message: ' + ((e as Error)?.message ?? e);
        }
      },
    }),
  };
}
