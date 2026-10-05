// Session idle digest — a periodic notification listing sessions that went
// quiet since the last check. Runs every N minutes (configurable, 0 = off).
// Each session that has been idle longer than the interval and hasn't been
// reported yet gets one line with its card number, status icon and a short
// LLM summary.
//
// The query: not held now, transcript updated, idle > threshold, not yet
// digested. "Not held now" includes a hold that ran out on its own — that is
// a turn whose holder DIED (a crashed window, a killed process), not one that
// finished, and the digest says so instead of summarizing it as done; the
// server log carries the same fact. After reporting, each session is stamped
// so it's never reported twice for the same activity. If it runs again and
// finishes again, it'll be reported again.

import { expiredHold, type PhantomBackend } from '@phantom-agent-sdk/backend';
import { oneShot, type OneShotDeps } from '../oneShot.js';
import { lastAssistantFromJsonl } from '@phantom-agent-sdk/backend';
import { titled } from '@phantom-agent-sdk/backend';
import { STATUS_ICON } from '@phantom-agent-sdk/backend';
import { logger } from '@phantom-agent-sdk/backend';

const log = logger('digest');

const TITLE = (count: number) => `📋 ${count} turn${count === 1 ? '' : 's'} completed:`;


const SYSTEM = `You summarize completed coding session turns.

You receive a JSON array of project groups, each with sessions sorted by last run time. Return the result as compact markdown — one bold project heading per group, then one line per session.

For sessions with a card, use: #<card> <icon> — <description>
For sessions without a card, use: • <description>
A session with "died_on" did NOT finish: its last turn died on that machine (the process crashed or was killed). Write its line as ⚠️ died on <died_on> — <what it was doing>, never as completed work.

Keep each description under 80 characters. No title, no extra text, just the project headings and lines.

Example input:
[{"project":"PHA","sessions":[{"card":7,"icon":"▶","name":"fix login redirect","last":"Resolved the OAuth callback loop by correcting the redirect URI"},{"card":12,"icon":"◇","name":"card schema","last":"Added a priority column and ran the migration"}]},{"project":"FOO","sessions":[{"name":"seed data","last":"Populated the test fixtures with realistic entries"}]}]

Example output:
**PHA**
#7 ▶ — fixed the OAuth callback loop
#12 ◇ — added priority column to card schema

**FOO**
• populated test fixtures with realistic data`;

/** The summary call: the grouped sessions in, the digest text out. It
 *  serves every quiet session at once, so it belongs to no one session. */
export class SessionDigest {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** On the backend's sessions, cards, projects, settings and notification
   *  channels; `oneShot` is the app's model call for the summary. */
  constructor(private readonly backend: PhantomBackend, private readonly oneShot: OneShotDeps) {}

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
      const min = Number(await this.backend.settings.resolve('session_digest_interval'));
      if (!Number.isFinite(min) || min <= 0) return 0;
      return min * 60_000;
    } catch { return 0; }
  }

  private tick(): void {
    if (this.running) return;
    this.running = true;
    this.run().catch((error) => log.warn({ err: (error as Error).message }, 'digest tick failed'))
      .finally(() => { this.running = false; });
  }

  private async run(): Promise<void> {
    const interval = await this.intervalMs();
    if (!interval) return;

    const threshold = new Date(Date.now() - interval);

    // Sessions that:
    // 1. Have a transcript (transcriptUpdatedAt is not null)
    // 2. Are not held now (released — or expired: the holder died mid-turn)
    // 3. Have been idle longer than the interval
    // 4. Haven't been digested since their last activity
    const rows = await this.backend.sessions.listIdleSince(threshold);

    if (!rows.length) return;

    // ── resolve project prefixes ───────────────────────────────────────────

    const wsIds = [...new Set(rows.map((row) => row.projectId))];
    const prefixByProjectId = new Map<string, string>();
    for (const projectId of wsIds) {
      const project = await this.backend.projects.get(projectId);
      if (project) prefixByProjectId.set(projectId, await this.backend.projects.prefixOf(project));
      else prefixByProjectId.set(projectId, projectId.slice(0, 3).toUpperCase());
    }

    // ── build per-session items ──────────────────────────────────────────────

    type Item = {
      name: string; lastMessage: string; wsPrefix: string;
      card?: number; icon?: string;
      /** The dead holder's label when the last turn died instead of ending. */
      diedOn?: string;
      ranAt: number; // epoch ms, for sorting
    };
    const items: Item[] = [];
    for (const session of rows) {
      const transcript = (await this.backend.sessions.transcript(session.id)) ?? '';
      const lastMsg = lastAssistantFromJsonl(transcript);

      let card: number | undefined;
      let icon: string | undefined;
      const onCard = await this.backend.cards.ofSession(session.id);
      if (onCard) {
        card = onCard.number;
        icon = STATUS_ICON[onCard.status]?.char ?? onCard.status;
      }

      // A hold that ran out is a turn that died. Said here in the log too:
      // the digest may be off or fail to send, and the death still happened.
      const died = expiredHold(session);
      if (died) {
        log.warn({ session: session.id, name: session.name, diedOn: died.label ?? died.by, expiredAt: died.at.toISOString() },
          'session turn died mid-turn — its hold expired without a release');
      }

      items.push({
        name: session.name ?? 'untitled',
        lastMessage: lastMsg ?? session.lastUserMessage ?? '(no messages)',
        wsPrefix: prefixByProjectId.get(session.projectId)!,
        card, icon,
        ...(died ? { diedOn: died.label ?? died.by } : {}),
        ranAt: session.transcriptUpdatedAt?.getTime() ?? 0,
      });
    }

    // ── group by project, sort by last run time ────────────────────────────

    const grouped = new Map<string, Item[]>();
    for (const item of items) {
      let list = grouped.get(item.wsPrefix);
      if (!list) { list = []; grouped.set(item.wsPrefix, list); }
      list.push(item);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.ranAt - b.ranAt);

    // ── build the JSON payload for the LLM ───────────────────────────────────

    const payload = [...grouped.entries()].map(([prefix, group]) => ({
      project: prefix,
      sessions: group.map((item) => {
        const entry: Record<string, unknown> = {};
        if (item.card != null) entry.card = item.card;
        if (item.icon) entry.icon = item.icon;
        if (item.diedOn) entry.died_on = item.diedOn;
        entry.name = item.name;
        entry.last = item.lastMessage.slice(0, 500);
        return entry;
      }),
    }));

    // ── LLM call ─────────────────────────────────────────────────────────────

    const text = await oneShot(this.oneShot, 'assistant', { type: 'session_digest', sessionId: null }, { system: SYSTEM, prompt: JSON.stringify(payload) });
    const message = titled(TITLE(rows.length), text.trim());

    if (!message) return;

    // Deliver to all channels.
    for (const channel of this.backend.notifications.channels()) {
      await channel.send(message).catch((error) =>
        log.warn({ channel: channel.name, err: (error as Error).message }, 'digest delivery failed'));
    }

    // Mark all as digested.
    const now = new Date();
    for (const session of rows) await this.backend.sessions.markDigested(session.id, now);

    log.info({ sessions: rows.length, channels: this.backend.notifications.channels().length }, 'digest sent');
  }
}
