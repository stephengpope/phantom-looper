// Session idle digest — a periodic notification listing sessions that finished
// since the last check. Runs every N minutes (configurable, 0 = off). Each
// session that has been idle longer than the interval and hasn't been reported
// yet gets one bullet with its name and a short outcome from the LLM.
//
// The query: unlocked, transcript updated, idle > threshold, not yet digested.
// After reporting, each session is stamped so it's never reported twice for the
// same activity. If it runs again and finishes again, it'll be reported again.

import { and, eq, isNull, lt, or, sql as sqlRaw } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, sessionColumns, loops } from '../db/schema.js';
import { helperCall } from '../helperCall.js';
import { agentModelConfig } from '../../core/llm/agentConfig.js';
import { resolve } from '../settings.js';
import { lastAssistantFromJsonl } from './transcriptHelper.js';
import type { NotificationChannel } from './channel.js';
import { logger } from '../log.js';

const log = logger('digest');

const TITLE = (n: number) => `📋 ${n} turn${n === 1 ? '' : 's'} completed:`;

const SYSTEM = `You summarize completed coding session turns as a bullet list. For each session you receive, write one line starting with • — the session name and a few words about what happened. Under 100 characters per line. No title, no extra text, just the bullets.`;

export interface DigestDeps {
  db: Db;
  encryptionKey: Buffer;
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
      const min = Number(await resolve(this.deps.db, 'session_digest_interval').catch(() => 5));
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
    const { db } = this.deps;
    const interval = await this.intervalMs();
    if (!interval) return;

    const threshold = new Date(Date.now() - interval);

    // Sessions that:
    // 1. Have a transcript (transcriptUpdatedAt is not null)
    // 2. Are not locked (lockedBy is null — the turn finished)
    // 3. Have been idle longer than the interval
    // 4. Haven't been digested since their last activity
    const rows = await db.select(sessionColumns).from(sessions).where(
      and(
        isNull(sessions.lockedBy),
        lt(sessions.transcriptUpdatedAt, threshold),
        or(
          isNull(sessions.digestNotifiedAt),
          sqlRaw`${sessions.transcriptUpdatedAt} > ${sessions.digestNotifiedAt}`,
        ),
      ),
    );

    if (!rows.length) return;

    // For each session, get the last assistant message and card info.
    const items: Array<{ name: string; lastMessage: string; cardStatus?: string }> = [];
    for (const s of rows) {
      const transcriptRows = await db.select({ data: sessions.transcript })
        .from(sessions).where(eq(sessions.id, s.id));
      const transcript = transcriptRows[0]?.data ?? '';
      const lastMsg = lastAssistantFromJsonl(transcript);

      // Check if this session has a card (via loops table).
      let cardStatus: string | undefined;
      const loopRows = await db.select().from(loops)
        .where(eq(loops.codingSessionId, s.id));
      if (loopRows.length) {
        cardStatus = `card #${loopRows[0].card}`;
      }

      items.push({
        name: s.name ?? 'untitled',
        lastMessage: lastMsg ?? s.lastUserMessage ?? '(no messages)',
        cardStatus,
      });
    }

    // Build the LLM prompt.
    const prompt = items.map((item, i) => {
      const parts = [`${i + 1}. ${item.name}`];
      if (item.cardStatus) parts[0] += ` (${item.cardStatus})`;
      parts.push(`Last: ${item.lastMessage.slice(0, 500)}`);
      return parts.join(' — ');
    }).join('\n\n');

    // One LLM call for the whole batch.
    let message: string;
    try {
      // Read the assistant model config from settings for the summary call.
      const settingsRows = await db.select().from(sessions).limit(0); // just need the resolve
      const values: Record<string, unknown> = {};
      for (const key of ['assistant_provider', 'assistant_model', 'assistant_base_url'] as const) {
        values[key] = await resolve(db, key).catch(() => undefined);
      }
      // Fall back to the coding agent's model if no assistant model is set.
      for (const key of ['provider', 'model', 'base_url'] as const) {
        values[key] = await resolve(db, key).catch(() => undefined);
      }
      const config = (() => { try { return agentModelConfig(values, 'assistant'); } catch { return undefined; } })();
      if (!config) { log.warn('no model configured — skipping digest'); return; }

      const { text } = await helperCall({
        db, config, kind: 'session_digest',
        system: SYSTEM,
        prompt: `Sessions that finished:\n\n${prompt}`,
      });
      const bullets = text.trim();
      message = `${TITLE(rows.length)}\n${bullets}`;
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'digest LLM call failed');
      // Fallback: just list session names, no LLM summary.
      const fallbackBullets = items.map((i) => `• ${i.name}`).join('\n');
      message = `${TITLE(rows.length)}\n${fallbackBullets}`;
    }

    if (!message) return;

    // Deliver to all channels.
    for (const ch of this.deps.channels) {
      await ch.send(message).catch((e) =>
        log.warn({ channel: ch.name, err: (e as Error).message }, 'digest delivery failed'));
    }

    // Mark all as digested.
    const now = new Date();
    for (const s of rows) {
      await db.update(sessions).set({ digestNotifiedAt: now })
        .where(eq(sessions.id, s.id));
    }

    log.info({ sessions: rows.length, channels: this.deps.channels.length }, 'digest sent');
  }
}
