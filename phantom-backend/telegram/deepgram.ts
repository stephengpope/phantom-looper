// Deepgram, both directions, for Telegram — the ONLY voice vendor here (the
// cli's voice pane runs Deepgram too, through the Python sidecar; the server
// has no sidecar, so these are the two REST calls). Deepgram sniffs the
// container itself, so Telegram's OGG/Opus goes up byte-for-byte — no ffmpeg,
// no format conversion, nothing to warm. Both calls ride connect.ts (the
// connection policy shared with the sidecar). Neither function throws: a
// missing key or a vendor failure comes back as a reason the caller can say.

import { connectFetch, isConnectFailure } from './connect.js';
import { logger } from '../log.js';

const log = logger('deepgram');

const API = process.env.DEEPGRAM_API_BASE ?? 'https://api.deepgram.com';

/** What a voice note came back as. `text` '' = heard no speech. The three
 *  reasons are three different sentences for the user. */
export type Transcription =
  | { text: string }
  | { error: 'no_key' | 'unreachable' | 'vendor' };

/** A voice note's words. One person, seconds long — no diarization. `model`
 *  is the voice_stt_model setting — the same model the voice pane hears with. */
export async function transcribeVoice(apiKey: string, audio: Buffer, model: string): Promise<Transcription> {
  if (!apiKey) return { error: 'no_key' };
  try {
    const res = await connectFetch(`${API}/v1/listen?model=${encodeURIComponent(model)}&smart_format=true`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/ogg' },
      body: new Uint8Array(audio),
    });
    if (!res.ok) return { error: 'vendor' };
    const json = await res.json() as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return { text: json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '' };
  } catch (e) {
    return { error: isConnectFailure(e) ? 'unreachable' : 'vendor' };
  }
}

/** Aura's per-request input ceiling. Over this the request is rejected. */
export const SPEAK_MAX_CHARS = 2000;

// ── Speech chunking ──────────────────────────────────────────────────────────
// Synthesis is ~260ms regardless of length (measured), so the constraint is the
// 2000-char API limit, not speed. The first chunk is kept small (~50 chars min)
// so audio arrives in under a second; later chunks fill the 2000-char limit
// since playback (~24s per 2000 chars) far exceeds synthesis time.

/** A sentence end: terminal punctuation, optional closing quote/bracket, then
 *  whitespace or end-of-string. */
const SENTENCE_END = /[.!?…]["''")\]]*(?:\s|$)/g;

/** Minimum chars for the first chunk — below this, take the next sentence too.
 *  ~50 chars ≈ 0.6s of audio, enough to start listening immediately. */
const FIRST_MIN = 50;

/**
 * Split `text` into speech chunks. First chunk is small (first sentence(s),
 * ≥ FIRST_MIN chars). Remaining chunks fill up to SPEAK_MAX_CHARS each. Never
 * cuts mid-sentence. Returns `[text]` unchanged when it fits in one request.
 */
export function splitForSpeech(text: string): string[] {
  const script = text.trim();
  if (!script || script.length <= SPEAK_MAX_CHARS) return script ? [script] : [];

  const breaks = sentenceBreaks(script);
  if (!breaks.length) return [script.slice(0, SPEAK_MAX_CHARS)]; // no sentences — hard cut as last resort

  const chunks: string[] = [];
  let pos = 0;

  // First chunk: take sentences until we pass FIRST_MIN.
  for (const b of breaks) {
    if (b >= FIRST_MIN && pos === 0) { chunks.push(script.slice(0, b).trim()); pos = b; break; }
  }
  // If no break reached FIRST_MIN, take the first sentence anyway.
  if (pos === 0) { chunks.push(script.slice(0, breaks[0]).trim()); pos = breaks[0]; }

  // Remaining chunks: fill up to SPEAK_MAX_CHARS at sentence boundaries.
  while (pos < script.length) {
    const rest = script.slice(pos);
    if (rest.trim().length <= SPEAK_MAX_CHARS) { chunks.push(rest.trim()); break; }
    const restBreaks = sentenceBreaks(rest);
    let cut = 0;
    for (const b of restBreaks) { if (b <= SPEAK_MAX_CHARS) cut = b; else break; }
    if (!cut) { chunks.push(rest.slice(0, SPEAK_MAX_CHARS).trim()); pos += SPEAK_MAX_CHARS; }
    else { chunks.push(rest.slice(0, cut).trim()); pos += cut; }
  }

  return chunks.filter(Boolean);
}

/** Every index just past a sentence end in `text`. */
function sentenceBreaks(text: string): number[] {
  const re = new RegExp(SENTENCE_END.source, 'g');
  const out: number[] = [];
  for (const m of text.matchAll(re)) out.push(m.index + m[0].length);
  return out;
}

/** Speak `text` as an OGG/Opus voice note — the container Telegram's voice
 *  bubbles want. `voice` is the Aura model (the voice_spoken_voice setting,
 *  e.g. aura-2-thalia-en). Null on any failure: the text already went out,
 *  so there is nothing to tell the user. */
export async function speakVoice(apiKey: string, voice: string, text: string): Promise<Buffer | null> {
  if (!apiKey || !text.trim()) return null;
  try {
    const model = encodeURIComponent(voice || 'aura-2-thalia-en');
    const res = await connectFetch(`${API}/v1/speak?model=${model}&encoding=opus&container=ogg`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, SPEAK_MAX_CHARS) }),
    });
    if (!res.ok) { log.warn({ status: res.status }, 'text-to-speech refused — the reply went as text'); return null; }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'text-to-speech failed — the reply went as text');
    return null;
  }
}
