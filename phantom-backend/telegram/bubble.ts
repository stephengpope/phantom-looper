// The "..." bubble a turn posts before it has anything real to show, growing a
// dot at a time so a slow start reads as waiting rather than as nothing
// happening. Two very different waits use it — the agent thinking before its
// first token (`stream.ts`) and a reaction being turned into audio
// (`speakReactedMessage`) — and it is one piece because the wait is the same
// wait from the user's side.
//
// EXCLUSIVE OWNERSHIP is the whole design. The bubble owns its message until
// somebody takes it: `claim()` hands the message id over and the bubble never
// touches it again, `remove()` deletes it. Before that split existed, the dot
// animation and the reply text wrote to one message through one shared queue in
// `stream.ts` — which worked, but only because both lived in the same closure.
// Pulling the animation out with its own queue would have meant two writers on
// one message and a dot landing on top of the first words of a reply.
//
// Every call is best-effort. A bubble that can't be posted is simply absent, and
// the caller falls back to posting its own message.

import type { TelegramClient } from './client.js';

/** The frames the bubble cycles through, one per `FRAME_MS`. */
const DOTS = ['...', '....', '.....', '......'];

/** Faster than Telegram's ~1 edit/sec ceiling on purpose — see the stop rules. */
const FRAME_MS = 600;

export interface WaitingBubble {
  /**
   * Take the message over. Waits for the post (and any frame still in flight) to
   * land so the id is truthful, stops the animation, and gives up ownership.
   * Returns null if the post failed or somebody already took it — the caller
   * then has no slot and should send its own message.
   */
  claim(): Promise<number | null>;
  /** Take it back and delete it. No-op once claimed. */
  remove(): Promise<void>;
  /** Freeze the animation without deciding the message's fate. */
  stop(): void;
}

// It is always a plain message, never a reply. A bubble stands in for an answer
// that has not arrived; pointing it at something is the answer's job, and this
// one is going to be deleted or written over either way.
export function startWaitingBubble(client: TelegramClient, chatId: number): WaitingBubble {
  let messageId: number | null = null;
  let owned = true;
  let frame = 0;

  // Everything this bubble does is chained, so a frame can't edit a message id
  // the post hasn't produced yet, and `claim()` awaiting the chain is what makes
  // the handover safe.
  let chain: Promise<void> = Promise.resolve();

  chain = chain.then(async () => {
    try {
      const m = await client.sendMessage(chatId, DOTS[0]);
      messageId = m?.message_id ?? null;
    } catch { /* no bubble; the caller posts its own message instead */ }
  });

  // Two stop conditions and deliberately no third:
  //
  //  - somebody took the message (or there never was one) — the animation is over
  //    the moment there is something real to show, which is the whole point;
  //  - an edit failed. `call()` retries a 429 INSIDE the chain, so a throttled
  //    frame would stall whatever is queued behind it. Stopping on the first
  //    error caps that at one retry ever, and frozen dots still read as waiting.
  const timer = setInterval(() => {
    chain = chain.then(async () => {
      if (!owned || messageId == null) { clearInterval(timer); return; }
      frame = (frame + 1) % DOTS.length;
      await client.editMessageText(chatId, messageId, DOTS[frame]);
    }).catch(() => { clearInterval(timer); });
  }, FRAME_MS);

  function stop() { clearInterval(timer); }

  async function claim(): Promise<number | null> {
    stop();
    await chain.catch(() => { /* a failed post just means no slot */ });
    if (!owned) return null;
    owned = false;
    return messageId;
  }

  async function remove(): Promise<void> {
    const id = await claim();
    if (id == null) return;
    await client.deleteMessage(chatId, id).catch(() => { /* best-effort */ });
  }

  return { claim, remove, stop };
}
