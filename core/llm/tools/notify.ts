/**
 * The NOTIFY kit — `send_message`: the agent DMs the user on Telegram,
 * deliberately, outside its reply. Over POST /sessions/:id/notify, so every
 * client running a coding session has it — a cli window, the looper, a cron
 * run, a Telegram chat — and the server delivers it exactly like a reply in a
 * Telegram chat: markdown, MEDIA: tags and bare /workspace paths as files,
 * spoken when the reply mode asks, and a reply to the bubble enters the session.
 *
 * Built only when `telegram_enabled` is on: Telegram off means no tool, not a
 * tool that goes nowhere (the crons kit's rule). Not a mutation of the repo,
 * so it works unchanged in plan mode.
 *
 * Description ported verbatim from ../shockwave (agent-core/sendMessage.ts).
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

export interface NotifyToolsConfig {
  baseUrl: string;
  apiKey: string;
  /** The session the DM is sent as — its work dir is where files come from. */
  sessionId: string;
  fetch?: typeof fetch;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export async function notifyTools(cfg: NotifyToolsConfig): Promise<Record<string, Tool>> {
  if (!await telegramEnabled(cfg)) return {};
  return buildNotifyTools(cfg);
}

/** The global `telegram_enabled`, resolved by the server. A read that fails
 *  throws, like every other kit's build — never a silent "no tools". */
async function telegramEnabled(cfg: NotifyToolsConfig): Promise<boolean> {
  const f = cfg.fetch ?? fetch;
  const r = await f(`${cfg.baseUrl}/settings`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
  const j = await r.json() as Envelope<Record<string, { value: unknown }>>;
  if (!j.ok) throw new Error(`could not read the settings: ${j.error.message}`);
  return j.data.telegram_enabled?.value === true;
}

function buildNotifyTools(cfg: NotifyToolsConfig): Record<string, Tool> {
  const f = cfg.fetch ?? fetch;
  return {
    send_message: tool({
      description:
        'Send the user a Telegram DM — the only way to reach them outside this chat.\n\n'
        + '"Send me", "notify me", "let me know", "ping me", "remind me", "tell me when" all mean CALL '
        + 'THIS, not write it down. Markdown is rendered; name a file\'s path (/workspace/...) or put '
        + 'MEDIA:/workspace/path/to/file on its own line and it is delivered with the message.',
      inputSchema: z.object({
        text: z.string().describe('The message to send.'),
      }),
      execute: async ({ text }) => {
        try {
          const r = await f(`${cfg.baseUrl}/sessions/${encodeURIComponent(cfg.sessionId)}/notify`, {
            method: 'POST',
            headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: String(text ?? '') }),
          });
          const j = await r.json() as Envelope<unknown>;
          return j.ok ? 'Message sent to the user on Telegram.' : `Could not send the message: ${j.error.message}`;
        } catch (e) {
          return 'Could not send the message: ' + ((e as Error)?.message ?? e);
        }
      },
    }),
  };
}
