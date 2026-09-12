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

/**
 * `voiceOnly`: when true the sink never types the answer out — only progress
 * (the placeholder bubble and a line per tool call) renders, so the chat is
 * not empty while the turn runs. The answer itself is delivered as a voice
 * note by the caller; typing it out here only to have it duplicated by audio
 * is what this flag prevents.
 */
export function makeTelegramSink(
  client: TelegramClient, chatId: number, deliver?: DeliverConfig,
  opts: { voiceOnly?: boolean } = {},
): TelegramSink {
  const voiceOnly = opts.voiceOnly === true;
  let text = '';                        // current assistant text segment
  let messageId: number | null = null;  // the message being edited for this segment
  let dirty = false;
  let lastEdit = 0;
  let unwritten = false;                // the held message has nothing real in it (a slot)
  let tookBubble = false;

  // ── Tool elapsed timer ──────────────────────────────────────────────────
  // A tool can run for 30+ seconds. Without this the chat freezes with no
  // sign of life. The line starts as `⚙️ bash · 0s`, the timer edits it
  // every 3s with the elapsed time. On tool-result, it becomes `⚙️ bash ✓`
  // — that tells the user "done, thinking about the result now".
  let toolMsgId: number | null = null;
  let toolEmoji = '🔧';
  let toolNameStr = 'tool';
  let toolStart = 0;
  let toolTimer: ReturnType<typeof setInterval> | null = null;

  function stopToolTimer() {
    if (toolTimer) { clearInterval(toolTimer); toolTimer = null; }
  }

  function startToolTimer(msgId: number, emoji: string, name: string) {
    stopToolTimer();
    toolMsgId = msgId; toolEmoji = emoji; toolNameStr = name;
    toolStart = Date.now();
    toolTimer = setInterval(() => {
      if (toolMsgId == null) { stopToolTimer(); return; }
      const sec = Math.round((Date.now() - toolStart) / 1000);
      chain = chain.then(async () => {
        if (toolMsgId == null) return;
        await client.editMessageText(chatId, toolMsgId, `${toolEmoji} ${toolNameStr} · ${sec}s`);
      }).catch(() => { stopToolTimer(); });
    }, 3000);
  }

  const THINKING_DOTS = ['💭 thinking ...', '💭 thinking ....', '💭 thinking .....', '💭 thinking ......'];
  let thinkingTimer: ReturnType<typeof setInterval> | null = null;
  let thinkingFrame = 0;
  let thinkingPending = false;   // set synchronously, cleared in chain or by markThinkingDone

  function stopThinking() {
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  }

  /** Mark thinking done with ✓, release the slot so the reply posts below it. */
  function markThinkingDone() {
    stopThinking();
    // Cancel a thinking bubble the chain hasn't sent yet (race: text-delta
    // arrives before the chain from markToolDone resolves).
    thinkingPending = false;
    if (!unwritten || messageId == null) return;
    const id = messageId;
    messageId = null; unwritten = false;
    chain = chain.then(async () => {
      await client.editMessageText(chatId, id, '💭 thinking ✓');
    }).catch(() => { /* best-effort */ });
  }

  function markToolDone() {
    stopToolTimer();
    if (toolMsgId == null) return;
    const id = toolMsgId;
    toolMsgId = null;
    thinkingPending = true;              // set synchronously — markThinkingDone can cancel
    chain = chain.then(async () => {
      await client.editMessageText(chatId, id, `${toolEmoji} ${toolNameStr} ✓`);
      // If text-delta arrived before we got here, thinkingPending was cleared
      // — skip the thinking bubble so it can't become a text message.
      if (!thinkingPending) return;
      thinkingPending = false;
      // "thinking" as a slot — the next text-delta edits into it, the next
      // tool-call takes it over. Either way it never lingers as a stale line.
      // Animated dots like the waiting bubble (600ms per frame).
      try {
        thinkingFrame = 0;
        const m = await client.sendMessage(chatId, THINKING_DOTS[0]);
        messageId = m?.message_id ?? null;
        unwritten = messageId != null;
        if (messageId != null) {
          const mid = messageId;
          thinkingTimer = setInterval(() => {
            thinkingFrame = (thinkingFrame + 1) % THINKING_DOTS.length;
            chain = chain.then(async () => {
              if (messageId !== mid || !unwritten) { stopThinking(); return; }
              await client.editMessageText(chatId, mid, THINKING_DOTS[thinkingFrame]);
            }).catch(() => { stopThinking(); });
          }, 600);
        }
      } catch { /* best-effort */ }
    }).catch(() => { thinkingPending = false; });
  }

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
    // Voice-only: the answer is the voice note. Progress (placeholder + tool
    // lines) still renders, but the streamed text does not — typing it out
    // only to have the same words read aloud is redundant.
    if (voiceOnly) { dirty = false; return; }
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
      stopToolTimer(); markThinkingDone();  // previous tool's timer (if any)
      text = '';                        // reset BEFORE any await — deltas append outside the chain
      await takeSlot();
      const slot = unwritten ? messageId : null;
      messageId = null; unwritten = false;
      const emoji = TOOL_EMOJI[name] || '🔧';
      const line = `${emoji} ${name} · 0s`;
      try {
        let mid: number | null = null;
        if (slot != null) { await client.editMessageText(chatId, slot, line); mid = slot; }
        else { const m = await client.sendMessage(chatId, line); mid = m?.message_id ?? null; }
        if (mid != null) startToolTimer(mid, emoji, name);
      } catch { /* best-effort */ }
    }).catch(() => { /* best-effort */ });
  }

  // One call arrives as TWO parts — tool-input-start while the arguments
  // stream (its id is `id`), tool-call once they are complete (`toolCallId`; a provider that does not
  // stream input sends only the second). One marker per call id.
  const marked = new Set<string>();
  function part(p: Record<string, unknown>) {
    const type = p.type;
    if (type === 'text-delta' && typeof p.text === 'string') {
      stopToolTimer(); markThinkingDone();  // model is talking — thinking done
      text += p.text; dirty = true;
    } else if (type === 'tool-input-start' || type === 'tool-call') {
      const id = typeof p.toolCallId === 'string' ? p.toolCallId : typeof p.id === 'string' ? p.id : null;
      if (id != null) { if (marked.has(id)) return; marked.add(id); }
      const name = typeof p.toolName === 'string' ? p.toolName : 'tool';
      toolLine(name);
    } else if (type === 'tool-result') {
      markToolDone();                   // ✓ with elapsed — "done, thinking now"
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
    stopToolTimer(); stopThinking(); thinkingPending = false;
    bubble.stop();
    await chain.catch(() => { /* best-effort */ });
    await dropPlaceholder();
  }

  async function done(finalText: string) {
    clearInterval(editTimer);
    stopToolTimer(); stopThinking(); thinkingPending = false;
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
    if (voiceOnly) {
      // Voice-only: the answer is the voice note, not text. Drop the
      // placeholder — the caller delivers audio after this returns.
      await dropPlaceholder();
    } else if (final) {
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
