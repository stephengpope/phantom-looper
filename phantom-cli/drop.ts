// File drops — a file dragged onto the terminal window arrives as a PASTE of
// its path: every terminal does this (iTerm2, Terminal.app, kitty, Windows
// Terminal), absolute, single-quoted or backslash-escaped when it carries
// spaces, some as a file:// URL. Caught in TextInput's paste channel before
// the chip check: the path never lands in the prompt as text — the window
// uploads the file into the session's scratch pad (POST /sessions/:id/attachments)
// and the agent hears where it landed through the backdoor message queue.
//
// The gate is strict so an ordinary paste can never trip it: EVERY word must
// LOOK dropped — a slash or the file:// scheme — AND exist as a file on
// disk. A bare `package.json` stays text even when such a file exists; so
// does a path that is not there.
import fs from 'node:fs';

/** Split what a terminal pastes for a drag into words the way a shell would:
 *  single and double quotes group, backslash escapes the next character.
 *  Null when the quoting is unbalanced — that is text, not a drop. */
function words(text: string): string[] | null {
  const out: string[] = [];
  let cur = '', quote: string | null = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === '\\') { if (i + 1 >= text.length) return null; cur += text[++i]; started = true; }
    else if (c === ' ' || c === '\t' || c === '\n') {
      if (started) { out.push(cur); cur = ''; started = false; }
    } else { cur += c; started = true; }
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

/** One word as a local file path plus whether it LOOKS dropped. A file://
 *  URL is unwrapped (always looks dropped); a remote one — a host that is
 *  not this machine — cannot be read, so it is not a path at all. */
function asLocalPath(word: string): { path: string; looked: boolean } | null {
  if (word.startsWith('file://')) {
    let u: URL;
    try { u = new URL(word); } catch { return null; }
    if (u.hostname && u.hostname !== 'localhost') return null;
    return { path: decodeURIComponent(u.pathname), looked: true };
  }
  return { path: word, looked: word.includes('/') };
}

/** Pasted text as a file drop: the dragged files' paths, or null when this
 *  is an ordinary paste and should be handled as text. */
export function parseDrop(text: string): string[] | null {
  const ws = words(text.trim());
  if (!ws?.length) return null;
  const paths: string[] = [];
  for (const w of ws) {
    const p = asLocalPath(w);
    if (!p?.looked) return null;
    try { if (!fs.statSync(p.path).isFile()) return null; } catch { return null; }
    paths.push(p.path);
  }
  return paths;
}
