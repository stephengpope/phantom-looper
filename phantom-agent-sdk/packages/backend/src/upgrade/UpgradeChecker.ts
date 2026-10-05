// Upgrade checker — periodic GitHub release check with Telegram notification.
// The server checks GitHub for a new release tag, compares it to its own
// version, and sends a Telegram DM with [Approve] [Deny] inline buttons.
// The same flow serves the /update command (manual check). One pending
// approval at a time; a new check while one stands is skipped silently.
//
// The approval uses callback prefix 'upg' (distinct from 'apv' for tool
// approvals in approvals.ts) so the engine's callback router can dispatch.

import crypto from 'node:crypto';
import type { TelegramApi } from '../telegram/TelegramApi.js';
import { titled } from '../telegram/TelegramApi.js';
import { checkLatest, isBehind, bare } from '@phantom-agent-sdk/client';
import { pullLine, type PullProgress, type UpdateEvent } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

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
  /** Trigger the upgrade (POST /update {tag}). Calls onEvent for each ND-JSON
   *  progress event from the server. */
  triggerUpdate(tag: string, onEvent?: (event: UpdateEvent) => void): Promise<{ ok: boolean; error?: string }>;
  /** Resolve a setting by key. */
  setting(key: string): Promise<unknown>;
  /** Get the bot token. */
  token(): Promise<string>;
  /** Get the authorized user's chat id, or null. */
  authorizedUser(): Promise<number | null>;
  /** Build a TelegramApi that records sent messages. */
  makeClient(token: string, chatId: number): TelegramApi;
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
    const chatId = await this.deps.authorizedUser();
    if (!chatId) return;

    const latest = await checkLatest();
    if (!latest) { log.debug('upgrade check: could not reach GitHub'); return; }
    if (!isBehind(this.deps.version, latest)) return;
    if (this.lastNotifiedTag === latest) return;

    const token = await this.deps.token();
    if (!token) return;

    await this.sendApproval(token, chatId, latest);
  }

  // ── /update command ───────────────────────────────────────────────────

  /** Manual check from /update. Always responds — even when current. */
  async manualCheck(client: TelegramApi, chatId: number): Promise<void> {
    if (this.pending) {
      await client.sendMessage(chatId, `⬆️ Already waiting for your answer on ${bare(this.pending.tag)}.`);
      return;
    }

    const latest = await checkLatest();
    if (!latest) {
      await client.sendMessage(chatId, "⚠️ Couldn't reach GitHub to check for updates — try again later.");
      return;
    }

    if (!isBehind(this.deps.version, latest)) {
      await client.sendMessage(chatId, `✅ You're on ${bare(this.deps.version)} — the latest.`);
      return;
    }

    // Re-use the existing client's token for the approval message.
    await this.sendApproval('', chatId, latest, client);
  }

  // ── callback handling ─────────────────────────────────────────────────

  /** A tap on an upgrade approval button. Returns true if handled. */
  async handleCallback(client: TelegramApi, chatId: number,
    query: { id: string; data?: string }): Promise<boolean> {
    const [prefix, id, verdict] = String(query.data ?? '').split(':');
    if (prefix !== PREFIX) return false;

    const pending = this.pending;
    if (!pending || pending.id !== id) {
      await client.answerCallbackQuery(query.id, 'That update prompt has expired.').catch(() => {});
      return true;
    }

    await client.answerCallbackQuery(query.id).catch(() => {});

    if (verdict === 'y') {
      await this.doUpgrade(client, chatId, pending);
    } else {
      // Denied — edit the message to show the decision.
      this.pending = null;
      if (pending.messageId != null) {
        await client.editMessageText(chatId, pending.messageId,
          `✖️ Update to ${bare(pending.tag)} skipped.`).catch(() => {});
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

  private async sendApproval(token: string, chatId: number, tag: string,
    existingClient?: TelegramApi): Promise<void> {
    const id = crypto.randomBytes(6).toString('hex');
    const version = bare(tag);
    const current = bare(this.deps.version);
    const client = existingClient ?? this.deps.makeClient(token, chatId);
    const sent = await client.sendMarkdown(chatId, titled(`⬆️ ${version} is available — you're on ${current}.`,
      'Updating restarts the server — any running turns are interrupted and resume after the restart.\n\n' +
      'Update?'), {
      replyMarkup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `${PREFIX}:${id}:y` },
        { text: '✖️ Deny', callback_data: `${PREFIX}:${id}:n` },
      ]] },
    });

    this.pending = { id, tag, chatId: chatId, messageId: sent?.message_id ?? null };
    this.lastNotifiedTag = tag;
    log.info({ tag, chatId }, 'upgrade notification sent');
  }

  private async doUpgrade(client: TelegramApi, chatId: number, pending: Pending): Promise<void> {
    const tag = pending.tag;
    const version = bare(tag);
    this.pending = null;

    // Edit the approval bubble to show the decision.
    if (pending.messageId != null) {
      await client.editMessageText(chatId, pending.messageId,
        `✅ Update to ${version} approved.`).catch(() => {});
    }

    // Send a progress message that we'll edit as events arrive.
    const msg = await client.sendMessage(chatId, `⬆️ Updating to ${version}...`);
    const msgId = msg?.message_id ?? null;

    // One bubble, edited as the update moves: the pull line (@phantom-agent-sdk/client update.ts
    // words it, the same as the cli), then the installer's latest line.
    const images: Record<string, PullProgress> = {};
    const show = (line: string) => { if (msgId) client.editMessageText(chatId, msgId, `⬆️ Updating to ${version}...\n${line}`).catch(() => {}); };
    const triggered = await this.deps.triggerUpdate(tag, (event) => {
      if (event.event === 'pulling') {
        images[event.image] = { download: event.download, unpack: event.unpack };
        show(pullLine(images));
      } else if (event.event === 'pulled') {
        show('Images on disk. Installing...');
      } else if (event.event === 'installing') {
        show(event.message);
      } else if (event.event === 'restarting') {
        show('Restarting — any running turns are interrupted and resume after the restart.');
      }
    });

    if (!triggered.ok) {
      const errText = `⚠️ Update to ${version} failed: ${triggered.error ?? 'unknown error'}`;
      if (msgId) { await client.editMessageText(chatId, msgId, errText).catch(() => {}); }
      else { await client.sendMessage(chatId, errText); }
      return;
    }

    log.info({ tag }, 'upgrade triggered via Telegram');
  }
}
