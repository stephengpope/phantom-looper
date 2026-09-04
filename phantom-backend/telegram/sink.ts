// Renders a session's live feed to Telegram: a `...` placeholder claimed by
// whichever output comes first, the assistant's text edited in place as it
// streams (~1.3s, under Telegram's ~1 edit/sec ceiling), a one-line marker per
// tool call, and an authoritative final splitFormatted into 4096-char chunks.
//
// It is a pure RENDERER of feed events — no db, no store, no settings. The
// caller subscribes it to sessionEvents and feeds it `part`s; the bubble and
// entities modules are ported from ../shockwave (stream.ts + waitingBubble.ts),
// but the event SOURCE is our session bus, not a removed onEvent callback.

import type { TelegramClient } from './client.js';
import { toTelegram, splitFormatted, truncateFormatted } from './entities.js';
import { startWaitingBubble } from './bubble.js';
import { collectDeliverables, extractMedia } from './mediaTags.js';

/** Where a reply's files may come from, and how a container path maps to the
 *  host file. Present only for code-mode turns (a session has a work dir);
 *  absent = no delivery (assistant turns with no session). */
export interface DeliverConfig {
  /** `/workspace/X` → host `work/<session>/X`. */
  toHost: (containerPath: string) => string;
  /** Host dirs a delivered file must resolve inside. */
  roots: string[];
}

const TOOL_EMOJI: Record<string, string> = {
  bash: '⚙️', read: '📖', write: '✍️', edit: '✏️', grep: '🔎', find: '🔎', ls: '📂',
  secret_get: '🔑', secret_list: '🔑', web_search: '🌐', web_fetch: '🌐',
  telegram_send_file: '📎', kanban_card_read: '📋', skill_load: '📚',
};

/** Fallback when the streamed text cleans down to nothing. */
const PLACEHOLDER = '…';

export interface TelegramSink {
  /** Feed one AI SDK stream part (the feed's `part.part`). */
  part(part: Record<string, unknown>): void;
  /** Close the reply: flush the authoritative final text, chunked. */
  done(finalText: string): Promise<void>;
  /** Tear down a turn that threw — never reached by done(). */
  dispose(): Promise<void>;
}

export function makeTelegramSink(
  client: TelegramClient, chatId: number, deliver?: DeliverConfig,
): TelegramSink {
  let text = '';                        // current assistant text segment
  let messageId: number | null = null;  // the message being edited for this segment
  let dirty = false;
  let lastEdit = 0;
  let unwritten = false;                // the held message has nothing real in it (a slot)
  let tookBubble = false;

  // Every flush is chained; done() awaits the chain so a first post still in
  // flight can't make done() send a second message.
  let chain: Promise<void> = Promise.resolve();

  // The placeholder goes up before the agent produces anything, so the wait
  // for the first token happens inside a bubble. Whichever of text or a tool
  // line renders first takes it over — one API call per turn.
  const bubble = startWaitingBubble(client, chatId);
  const editTimer = setInterval(() => { void flush(false); }, 1300);

  async function takeSlot() {
    if (tookBubble) return;
    tookBubble = true;
    messageId = await bubble.claim();
    unwritten = messageId != null;
  }

  function flush(force: boolean): Promise<void> {
    chain = chain.then(() => flushInner(force)).catch(() => { /* best-effort */ });
    return chain;
  }

  async function flushInner(force: boolean) {
    if (!dirty) return;
    if (!force && Date.now() - lastEdit < 1300) return;
    dirty = false; lastEdit = Date.now();
    await takeSlot();
    // Strip MEDIA: tags as we stream (delivery turns only) so the user never
    // watches `MEDIA:/workspace/...` get typed out and then vanish. Bare paths
    // read as prose and are left until the final delivery pass.
    const shown = deliver ? extractMedia(text).cleaned : text;
    // Formatted on EVERY frame — an entity list has no invalid state, so an
    // unclosed `**` just renders as itself until it closes.
    const fmt = truncateFormatted(toTelegram(shown), 4096);
    const body = fmt.text || PLACEHOLDER;
    const entities = fmt.text ? fmt.entities : [];
    try {
      if (messageId == null) { const m = await client.sendMessage(chatId, body, { entities }); messageId = m?.message_id ?? null; }
      else await client.editMessageText(chatId, messageId, body, entities);
      unwritten = body === PLACEHOLDER;
    } catch { /* rate limit / transient — the final flush corrects it */ }
  }

  function toolLine(name: string) {
    void flush(true);                   // close the current text segment first
    chain = chain.then(async () => {
      text = '';                        // reset BEFORE any await — deltas append outside the chain
      await takeSlot();
      const slot = unwritten ? messageId : null;
      messageId = null; unwritten = false;
      const line = `${TOOL_EMOJI[name] || '🔧'} ${name}`;
      try {
        if (slot != null) await client.editMessageText(chatId, slot, line);
        else await client.sendMessage(chatId, line);
      } catch { /* best-effort */ }
    }).catch(() => { /* best-effort */ });
  }

  function part(p: Record<string, unknown>) {
    const type = p.type;
    if (type === 'text-delta' && typeof p.text === 'string') { text += p.text; dirty = true; }
    else if (type === 'tool-input-start' || type === 'tool-call') {
      const name = typeof p.toolName === 'string' ? p.toolName : 'tool';
      toolLine(name);
    }
  }

  async function dropPlaceholder() {
    if (!tookBubble) { await bubble.remove(); return; }
    if (!unwritten || messageId == null) return;
    const id = messageId;
    messageId = null; unwritten = false;
    await client.deleteMessage(chatId, id).catch(() => { /* best-effort */ });
  }

  async function dispose() {
    clearInterval(editTimer);
    bubble.stop();
    await chain.catch(() => { /* best-effort */ });
    await dropPlaceholder();
  }

  async function done(finalText: string) {
    clearInterval(editTimer);
    bubble.stop();
    await chain;                        // let any in-flight post land

    // Find the files the agent named, cut them from the text, and hold them to
    // send after the words. Delivery turns only (a session's work dir).
    let final = finalText.trim();
    let files: { path: string; kind: string }[] = [];
    if (deliver && final) {
      const got = await collectDeliverables(final, deliver.toHost, deliver.roots);
      final = got.cleaned.trim();
      files = got.files;
    }

    await takeSlot();                   // a turn that rendered nothing still edits into the bubble
    if (final) {
      try {
        const chunks = splitFormatted(toTelegram(final));
        if (messageId != null) await client.editMessageText(chatId, messageId, chunks[0].text, chunks[0].entities);
        else { const m = await client.sendMessage(chatId, chunks[0].text, { entities: chunks[0].entities }); messageId = m?.message_id ?? null; }
        for (const c of chunks.slice(1)) await client.sendMessage(chatId, c.text, { entities: c.entities });
      } catch { /* best-effort — the record is the transcript */ }
    } else if (!files.length) {
      await dropPlaceholder();          // nothing to say and nothing to send
    } else {
      await dropPlaceholder();          // only files — drop the empty bubble, send them below
    }

    // Files after the words, so the message explaining them arrives first. A
    // failure is reported, not swallowed — "here's your report" with no report
    // is the worst outcome.
    for (const f of files) {
      try {
        await client.sendFile(f.kind as Parameters<TelegramClient['sendFile']>[0], chatId, f.path);
      } catch (e) {
        await client.sendMessage(chatId, `⚠️ Couldn't send that file — ${(e as Error).message}`).catch(() => {});
      }
    }
  }

  return { part, done, dispose };
}
