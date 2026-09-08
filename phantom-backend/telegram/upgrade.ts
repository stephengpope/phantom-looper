// Upgrade checker — periodic GitHub release check with Telegram notification.
// The server checks GitHub for a new release tag, compares it to its own
// version, and sends a Telegram DM with [Approve] [Deny] inline buttons.
// The same flow serves the /upgrade command (manual check). One pending
// approval at a time; a new check while one stands is skipped silently.
//
// The approval uses callback prefix 'upg' (distinct from 'apv' for tool
// approvals in approvals.ts) so the engine's callback router can dispatch.

import crypto from 'node:crypto';
import type { TelegramClient } from './client.js';
import { checkLatest, isBehind, bare } from '../../core/version.js';
import { logger, errStr } from '../log.js';

const log = logger('upgrade');

const PREFIX = 'upg';

interface Pending {
  id: string;
  tag: string;
  chatId: number;
  messageId: number | null;
}

export interface UpgradeCheckerDeps {
  /** This server's APP_VERSION. */
  version: string;
  /** Read the health endpoint for loops_running. */
  health(): Promise<{ loops_running?: number } | null>;
  /** Trigger the upgrade (POST /update {tag}). */
  triggerUpdate(tag: string): Promise<{ ok: boolean; error?: string }>;
  /** Resolve a setting by key. */
  setting(key: string): Promise<unknown>;
  /** Get the bot token. */
  token(): Promise<string>;
  /** Get the authorized user's chat id, or null. */
  authorizedUser(): Promise<number | null>;
  /** Build a TelegramClient that records sent messages. */
  makeClient(token: string, dm: number): TelegramClient;
}

export class UpgradeChecker {
  private pending: Pending | null = null;
  /** The last tag we notified about — don't re-notify until a restart or a
   *  new version appears. */
  private lastNotifiedTag: string | null = null;

  constructor(private deps: UpgradeCheckerDeps) {}

  // ── periodic check ────────────────────────────────────────────────────

  /** Called from the periodic loop. Checks GitHub, compares to VERSION,
   *  sends a notification if behind. Silent when Telegram is off, or
   *  when a notification for the same tag was already sent. */
  async check(): Promise<void> {
    // Don't stack notifications.
    if (this.pending) return;

    const enabled = await this.deps.setting('telegram_enabled');
    if (enabled !== true) return;
    const dm = await this.deps.authorizedUser();
    if (!dm) return;

    const latest = await checkLatest();
    if (!latest) { log.debug('upgrade check: could not reach GitHub'); return; }
    if (!isBehind(this.deps.version, latest)) return;
    if (this.lastNotifiedTag === latest) return;

    const token = await this.deps.token();
    if (!token) return;

    await this.sendApproval(token, dm, latest);
  }

  // ── /upgrade command ──────────────────────────────────────────────────

  /** Manual check from /upgrade. Always responds — even when current. */
  async manualCheck(client: TelegramClient, dm: number): Promise<void> {
    if (this.pending) {
      await client.sendMessage(dm, `⬆️ Already waiting for your answer on ${bare(this.pending.tag)}.`);
      return;
    }

    const latest = await checkLatest();
    if (!latest) {
      await client.sendMessage(dm, "⚠️ Couldn't reach GitHub to check for updates — try again later.");
      return;
    }

    if (!isBehind(this.deps.version, latest)) {
      await client.sendMessage(dm, `✅ You're on ${bare(this.deps.version)} — the latest.`);
      return;
    }

    // Re-use the existing client's token for the approval message.
    await this.sendApproval('', dm, latest, client);
  }

  // ── callback handling ─────────────────────────────────────────────────

  /** A tap on an upgrade approval button. Returns true if handled. */
  async handleCallback(client: TelegramClient, dm: number,
    query: { id: string; data?: string }): Promise<boolean> {
    const [prefix, id, verdict] = String(query.data ?? '').split(':');
    if (prefix !== PREFIX) return false;

    const p = this.pending;
    if (!p || p.id !== id) {
      await client.answerCallbackQuery(query.id, 'That upgrade prompt has expired.').catch(() => {});
      return true;
    }

    await client.answerCallbackQuery(query.id).catch(() => {});

    if (verdict === 'y') {
      await this.doUpgrade(client, dm, p);
    } else {
      // Denied — edit the message to show the decision.
      this.pending = null;
      if (p.messageId != null) {
        await client.editMessageText(dm, p.messageId,
          `✖️ Upgrade to ${bare(p.tag)} skipped.`).catch(() => {});
      }
    }
    return true;
  }

  /** Is a callback_data string ours? Quick prefix test so the engine can
   *  route without parsing. */
  static isUpgradeCallback(data: string | undefined): boolean {
    return String(data ?? '').startsWith(`${PREFIX}:`);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async sendApproval(token: string, dm: number, tag: string,
    existingClient?: TelegramClient): Promise<void> {
    const id = crypto.randomBytes(6).toString('hex');
    const v = bare(tag);
    const current = bare(this.deps.version);
    const text = `⬆️ ${v} is available — you're on ${current}.\n` +
      'Upgrading restarts the server — any running turns are stopped and loop cards are blocked.\n\n' +
      'Upgrade?';

    const client = existingClient ?? this.deps.makeClient(token, dm);
    const m = await client.sendMessage(dm, text, {
      replyMarkup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `${PREFIX}:${id}:y` },
        { text: '✖️ Deny', callback_data: `${PREFIX}:${id}:n` },
      ]] },
    });

    this.pending = { id, tag, chatId: dm, messageId: m?.message_id ?? null };
    this.lastNotifiedTag = tag;
    log.info({ tag, dm }, 'upgrade notification sent');
  }

  private async doUpgrade(client: TelegramClient, dm: number, p: Pending): Promise<void> {
    const tag = p.tag;
    const v = bare(tag);
    this.pending = null;

    // Edit the approval bubble to show the decision.
    if (p.messageId != null) {
      await client.editMessageText(dm, p.messageId,
        `✅ Upgrade to ${v} approved.`).catch(() => {});
    }

    // Trigger the upgrade.
    const r = await this.deps.triggerUpdate(tag);
    if (!r.ok) {
      await client.sendMessage(dm,
        `⚠️ Could not start the upgrade: ${r.error ?? 'unknown error'}`);
      return;
    }

    await client.sendMessage(dm,
      `⬆️ Upgrading to ${v}... The server will restart shortly — ` +
      'any running turns are stopped and loop cards are blocked.');
    log.info({ tag }, 'upgrade triggered via Telegram');
  }
}
