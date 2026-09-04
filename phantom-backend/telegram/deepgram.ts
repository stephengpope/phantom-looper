// Deepgram, both directions, for Telegram — the ONLY voice vendor here (the
// cli's voice pane runs Deepgram too, through the Python sidecar; the server
// has no sidecar, so these are the two REST calls). Deepgram sniffs the
// container itself, so Telegram's OGG/Opus goes up byte-for-byte — no ffmpeg,
// no format conversion, nothing to warm. Neither function throws: a missing
// key or a vendor failure comes back null and the caller says so readably.

const API = process.env.DEEPGRAM_API_BASE ?? 'https://api.deepgram.com';

/** A voice note's words. One person, seconds long — no diarization. Null =
 *  couldn't transcribe (no key, vendor error); '' = heard no speech. */
export async function transcribeVoice(apiKey: string, audio: Buffer): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${API}/v1/listen?model=nova-2&smart_format=true`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/ogg' },
      body: new Uint8Array(audio),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  } catch {
    return null;
  }
}

/** Aura's per-request input ceiling. A longer script is CUT, not rejected —
 *  over the limit the whole request fails, which loses the audio entirely;
 *  cutting costs the listener the tail and the reader nothing, because the
 *  full text is delivered in writing on every mode but voice-only, and
 *  voice-only falls back to text when the audio comes back short. */
export const SPEAK_MAX_CHARS = 2000;

/** Speak `text` as an OGG/Opus voice note — the container Telegram's voice
 *  bubbles want. `voice` is the Aura model (the voice_spoken_voice setting,
 *  e.g. aura-2-thalia-en). Null on any failure. */
export async function speakVoice(apiKey: string, voice: string, text: string): Promise<Buffer | null> {
  if (!apiKey || !text.trim()) return null;
  try {
    const model = encodeURIComponent(voice || 'aura-2-thalia-en');
    const res = await fetch(`${API}/v1/speak?model=${model}&encoding=opus&container=ogg`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, SPEAK_MAX_CHARS) }),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
