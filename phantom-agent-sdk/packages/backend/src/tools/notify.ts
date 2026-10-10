// The NOTIFY tool — send_message: the agent DMs the user on Telegram, outside
// its reply. Offered only when Telegram is wired and `telegram_enabled` is
// on: Telegram off means no tool.
import { obj, refusal, str, type OfferCtx, type ToolDef } from './def.js';
import { textOf } from '../lib/text.js';

const enabled = async ({ app }: OfferCtx) => app.notifications.available && Boolean(await app.settings.resolve('telegram_enabled'));

export const NOTIFY_TOOLS: ToolDef[] = [
  {
    name: 'send_message',
    summary: 'Send the user a Telegram DM.',
    description: 'Send the user a Telegram DM — the only way to reach them outside this chat.\n\n'
      + '"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" all mean CALL '
      + 'THIS, not write it down. Markdown is rendered; name a file\'s path (/workspace/...) or put '
      + 'MEDIA:/workspace/path/to/file on its own line and it is delivered with the message.',
    input: obj({ text: str('The message to send.') }, ['text']),
    mutates: false, group: 'notify', offered: enabled,
    async execute(ctx, a) {
      try {
        await ctx.app.notifications.send(textOf(a.text), { sessionId: ctx.session.id });
        return { sent: true };
      } catch (error) {
        throw refusal('telegram_unavailable', `could not send the message: ${(error as Error).message}`);
      }
    },
  },
];
