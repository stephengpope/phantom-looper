// Session idle digest — a periodic notification listing sessions that finished
// since the last check. Runs every N minutes (configurable, 0 = off). Each
// session that has been idle longer than the interval and hasn't been reported
// yet gets one line with its card number, status icon and a short LLM summary.
//
// The query: unlocked, transcript updated, idle > threshold, not yet digested.
// After reporting, each session is stamped so it's never reported twice for the
// same activity. If it runs again and finishes again, it'll be reported again.

import type { Sessions } from '../sessions.js';
import type { Loops } from '../loops.js';
import type { Cards } from '../cards.js';
import type { Settings } from '../settings.js';
import type { Workspaces } from '../workspaces.js';
import type { SessionRow } from '../db/schema.js';
import { helperCall } from '../../core/llm/helperCall.js';
import { agentModelConfig } from '../../core/llm/agentConfig.js';
import { lastAssistantFromJsonl } from './transcriptHelper.js';
import type { NotificationChannel } from './channel.js';
import { titled } from '../telegram/client.js';
import { logger } from '../log.js';

const log = logger('digest');

const TITLE = (n: number) => `📋 ${n} turn${n === 1 ? '' : 's'} completed:`;

// Kanban column → icon. The cli's Launcher.tsx carries color; we only need the
// character for a plain-text Telegram message.
const STATUS_ICON: Record<string, string> = {
  backlog: '○', plan: '◇', in_progress: '▶',
  blocked: '✕', done: '✓', archived: '▪',
};

const SYSTEM = `You summarize completed coding session turns.

You receive a JSON array of workspace groups, each with sessions sorted by last run time. Return the result as compact markdown — one bold workspace heading per group, then one line per session.

For sessions with a card, use: #<card> <icon> — <description>
For sessions without a card, use: • <description>

Keep each description under 80 characters. No title, no extra text, just the workspace headings and lines.

Example input:
[{"workspace":"PHA","sessions":[{"card":7,"icon":"▶","name":"fix login redirect","last":"Resolved the OAuth callback loop by correcting the redirect URI"},{"card":12,"icon":"◇","name":"card schema","last":"Added a priority column and ran the migration"}]},{"workspace":"FOO","sessions":[{"name":"seed data","last":"Populated the test fixtures with realistic entries"}]}]

Example output:
**PHA**
#7 ▶ — fixed the OAuth callback loop
#12 ◇ — added priority column to card schema

**FOO**
• populated test fixtures with realistic data`;

export interface DigestDeps {
  sessions: Sessions;
  loops: Loops;
  cards: Cards;
  settings: Settings;
  workspaces: Workspaces;
  channels: NotificationChannel[];
}

export class SessionDigest {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private deps: DigestDeps) {}

  /** Start the periodic check. Call once at boot; reconcile() restarts it
   *  when the interval setting changes. */
  async start(): Promise<void> {
    this.stop();
    const interval = await this.intervalMs();
    if (!interval) return;
    this.timer = setInterval(() => { this.tick(); }, interval);
    log.info({ intervalMin: interval / 60_000 }, 'session digest started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Re-read the setting and restart the timer if it changed. */
  async reconcile(): Promise<void> {
    await this.start();
  }

  private async intervalMs(): Promise<number> {
    try {
      const min = Number(await this.deps.settings.resolve('session_digest_interval').catch(() => 5));
      if (!Number.isFinite(min) || min <= 0) return 0;
      return min * 60_000;
    } catch { return 0; }
  }

  private tick(): void {
    if (this.running) return;
    this.running = true;
    this.run().catch((e) => log.warn({ err: (e as Error).message }, 'digest tick failed'))
      .finally(() => { this.running = false; });
  }

  private async run(): Promise<void> {
    const interval = await this.intervalMs();
    if (!interval) return;

    const threshold = new Date(Date.now() - interval);

    // Sessions that:
    // 1. Have a transcript (transcriptUpdatedAt is not null)
    // 2. Are not locked (lockedBy is null — the turn finished)
    // 3. Have been idle longer than the interval
    // 4. Haven't been digested since their last activity
    const rows = await this.deps.sessions.listIdleSince(threshold);

    if (!rows.length) return;

    // ── resolve workspace prefixes ───────────────────────────────────────────

    const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
    const wsByIdMap = new Map<string, Awaited<ReturnType<Workspaces['get']>>>();
    const prefixByWsId = new Map<string, string>();
    for (const wsId of wsIds) {
      const ws = await this.deps.workspaces.get(wsId);
      wsByIdMap.set(wsId, ws);
      if (ws) prefixByWsId.set(wsId, await this.deps.workspaces.prefixOf(ws));
      else prefixByWsId.set(wsId, wsId.slice(0, 3).toUpperCase());
    }

    // ── build per-session items ──────────────────────────────────────────────

    type Item = {
      name: string; lastMessage: string; wsPrefix: string;
      card?: number; icon?: string;
      ranAt: number; // epoch ms, for sorting
    };
    const items: Item[] = [];
    for (const s of rows) {
      const transcript = (await this.deps.sessions.transcript(s.id)) ?? '';
      const lastMsg = lastAssistantFromJsonl(transcript);

      let card: number | undefined;
      let icon: string | undefined;
      const loop = await this.deps.loops.byCodingSession(s.id);
      if (loop) {
        card = loop.card;
        const ws = wsByIdMap.get(s.workspaceId);
        if (ws) {
          const statuses = await this.deps.cards.statusOf(ws, [loop.card]);
          const col = statuses.get(loop.card);
          if (col) icon = STATUS_ICON[col] ?? col;
        }
      }

      items.push({
        name: s.name ?? 'untitled',
        lastMessage: lastMsg ?? s.lastUserMessage ?? '(no messages)',
        wsPrefix: prefixByWsId.get(s.workspaceId)!,
        card, icon,
        ranAt: (s as SessionRow & { transcriptUpdatedAt: Date | null }).transcriptUpdatedAt?.getTime() ?? 0,
      });
    }

    // ── group by workspace, sort by last run time ────────────────────────────

    const grouped = new Map<string, Item[]>();
    for (const item of items) {
      let list = grouped.get(item.wsPrefix);
      if (!list) { list = []; grouped.set(item.wsPrefix, list); }
      list.push(item);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.ranAt - b.ranAt);

    // ── build the JSON payload for the LLM ───────────────────────────────────

    const payload = [...grouped.entries()].map(([prefix, group]) => ({
      workspace: prefix,
      sessions: group.map((item) => {
        const entry: Record<string, unknown> = {};
        if (item.card != null) entry.card = item.card;
        if (item.icon) entry.icon = item.icon;
        entry.name = item.name;
        entry.last = item.lastMessage.slice(0, 500);
        return entry;
      }),
    }));

    // ── LLM call ─────────────────────────────────────────────────────────────

    const values: Record<string, unknown> = {};
    for (const key of ['assistant_provider', 'assistant_model', 'assistant_base_url'] as const) {
      values[key] = await this.deps.settings.resolve(key).catch(() => undefined);
    }
    for (const key of ['provider', 'model', 'base_url'] as const) {
      values[key] = await this.deps.settings.resolve(key).catch(() => undefined);
    }
    const config = agentModelConfig(values, 'assistant');

    const { text } = await helperCall({
      config, usage: { kind: 'session_digest' },
      system: SYSTEM,
      prompt: JSON.stringify(payload),
    });
    const message = titled(TITLE(rows.length), text.trim());

    if (!message) return;

    // Deliver to all channels.
    for (const ch of this.deps.channels) {
      await ch.send(message).catch((e) =>
        log.warn({ channel: ch.name, err: (e as Error).message }, 'digest delivery failed'));
    }

    // Mark all as digested.
    const now = new Date();
    for (const s of rows) await this.deps.sessions.markDigested(s.id, now);

    log.info({ sessions: rows.length, channels: this.deps.channels.length }, 'digest sent');
  }
}
