// Finding files the agent wants to send, in the text it wrote. Ported from
// ../shockwave (agent-core/mediaTags.ts) — the masking paranoia is load-bearing
// and kept verbatim.
//
// The agent delivers a file by NAMING its path in its reply — bare
// (`/workspace/scratch/out.pdf`) or flagged (`MEDIA:/workspace/scratch/out.pdf`).
// This finds those paths, cuts them from the text the user reads, and says how
// each should be sent. It knows nothing about Telegram; the caller delivers.
//
// One adaptation for us: the agent names CONTAINER paths (/workspace/...). The
// caller passes a `toHost` map so the on-disk check and delivery hit the real
// file (work/<session>/...); `allowedRoots` are host dirs. Bare-path delivery
// needs NOTHING in the prompt, so it works for every session, old ones included.

import fs from 'node:fs/promises';
import path from 'node:path';

/** Extensions we will deliver. Anything else is not a file the user gets. */
export const MEDIA_DELIVERY_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.mp3', '.wav', '.ogg', '.opus', '.m4a', '.flac',
  '.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.epub',
  '.xlsx', '.xls', '.ods', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.pptx', '.ppt', '.odp', '.key',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.apk', '.ipa',
  '.html', '.htm',
];

// Longest-first, so the alternation never matches a short extension where a
// longer one was meant.
const EXT_ALTERNATION = MEDIA_DELIVERY_EXTS
  .map((e) => e.slice(1)).sort((a, b) => b.length - a.length).join('|');

const MEDIA_TAG_SRC =
  '[`"\']?MEDIA:\\s*'
  + '(?<path>`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|'
  + `(?:~/|/|[A-Za-z]:[/\\\\])\\S+(?:[^\\S\\n]+\\S+)*?\\.(?:${EXT_ALTERNATION}))`
  + '(?=[\\s`"\',;:)\\]}]|$)[`"\']?';
const BARE_PATH_SRC =
  `(?<![/:\\w.])(?:~/|/|[A-Za-z]:[/\\\\])(?:[\\w.\\-]+[/\\\\])*[\\w.\\-]+\\.(?:${EXT_ALTERNATION})\\b`;

const mediaTagRe = () => new RegExp(MEDIA_TAG_SRC, 'gi');
const barePathRe = () => new RegExp(BARE_PATH_SRC, 'gi');

// Every span here comes from a regex match, whose `index` counts UTF-16 code
// units — so the text is split into code units too, never `Array.from`
// (code points): an emoji ahead of a MEDIA: tag shifted every cut by one and
// left `🎉 Mdone` on screen. Span edges are ASCII (backticks, quotes, the tag),
// so a surrogate pair is always replaced or cut whole.
const units = (text: string): string[] => text.split('');

/** Replace a span with spaces, keeping newlines and total length. */
function blank(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
}

/** Blank fenced code, inline code, and blockquotes — where a path is SHOWN, not
 *  sent. A backtick span right after `MEDIA:` is a quoted path, not code. */
export function maskProtectedSpans(content: string): string {
  const chars = units(content);
  const spans: Array<[number, number]> = [];
  for (const m of content.matchAll(/```[^\n]*\n[\s\S]*?```/g)) spans.push([m.index!, m.index! + m[0].length]);
  for (const m of content.matchAll(/`[^`\n]+`/g)) {
    if (/MEDIA:\s*$/.test(content.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of content.matchAll(/^>.*$/gm)) spans.push([m.index!, m.index! + m[0].length]);
  for (const [s, e] of spans) blank(chars, s, e);
  return chars.join('');
}

/** Blank a bare `MEDIA:` inside a JSON string VALUE — a stored tool result
 *  echoing an earlier reply would otherwise re-send the file every later turn. */
export function maskJsonStringMedia(content: string): string {
  if (!content.includes('"') || !content.includes('MEDIA:')) return content;
  const chars = units(content);
  for (const m of content.matchAll(/(?<=[:,{[])\s*"((?:[^"\\\n]|\\.)*)"/g)) {
    if (!/MEDIA:\s*(?:~\/|\/|[A-Za-z]:[/\\])/.test(m[1])) continue;
    const bodyStart = m.index! + m[0].indexOf('"') + 1;
    blank(chars, bodyStart, bodyStart + m[1].length);
  }
  return chars.join('');
}

function unquote(raw: string | undefined): string {
  let p = String(raw ?? '').trim();
  if (p.length >= 2 && p[0] === p[p.length - 1] && '`"\''.includes(p[0])) p = p.slice(1, -1).trim();
  return p.replace(/^[`"']+/, '').replace(/[`"',.;:)}\]]+$/, '');
}

export interface Media { path: string; isVoice: boolean }

/** Pull `MEDIA:` tags out of a reply. `cleaned` is what the bare-path pass must
 *  scan next — that chaining is the dedup between the two mechanisms. */
export function extractMedia(content: string): { media: Media[]; cleaned: string; forceDocument: boolean } {
  const src = String(content ?? '');
  const forceDocument = src.includes('[[as_document]]');
  const isVoice = src.includes('[[audio_as_voice]]');
  let cleaned = src.split('[[audio_as_voice]]').join('').split('[[as_document]]').join('');

  const scan = maskJsonStringMedia(maskProtectedSpans(src));
  const media: Media[] = [];
  for (const m of scan.matchAll(mediaTagRe())) {
    const p = unquote(m.groups?.path);
    if (p) media.push({ path: p, isVoice });
  }
  if (media.length) {
    const maskedCleaned = maskJsonStringMedia(maskProtectedSpans(cleaned));
    const spans: Array<[number, number]> = [];
    for (const m of maskedCleaned.matchAll(mediaTagRe())) spans.push([m.index!, m.index! + m[0].length]);
    if (spans.length) {
      const chars = units(cleaned);
      for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) chars.splice(s, e - s);
      cleaned = chars.join('').replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  return { media, cleaned, forceDocument };
}

/** Bare paths the agent named. Returns the raw strings (no on-disk check — that
 *  happens after mapping to host) and the text with them removed. Paths shown
 *  in code are ignored. */
export function extractBarePaths(content: string): { paths: string[]; cleaned: string } {
  const src = String(content ?? '');
  const codeSpans: Array<[number, number]> = [];
  for (const m of src.matchAll(/```[^\n]*\n[\s\S]*?```/g)) codeSpans.push([m.index!, m.index! + m[0].length]);
  for (const m of src.matchAll(/`[^`\n]+`/g)) codeSpans.push([m.index!, m.index! + m[0].length]);
  const inCode = (pos: number) => codeSpans.some(([s, e]) => pos >= s && pos < e);

  const raws: string[] = [];
  for (const m of src.matchAll(barePathRe())) {
    if (inCode(m.index!)) continue;
    if (!raws.includes(m[0])) raws.push(m[0]);
  }
  let cleaned = src;
  for (const raw of raws) cleaned = cleaned.split(raw).join('');
  if (raws.length) cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { paths: raws, cleaned };
}

/** Accept a HOST path only if it resolves inside one of `allowedRoots`.
 *  Symlinks are resolved first, so a link inside a root can't point out. */
export async function validateDeliveryPath(hostPath: string, allowedRoots: string[]): Promise<string | null> {
  if (!path.isAbsolute(hostPath)) return null;
  let resolved: string;
  try {
    resolved = await fs.realpath(hostPath);
    if (!(await fs.stat(resolved)).isFile()) return null;
  } catch { return null; }
  for (const root of allowedRoots) {
    if (!root) continue;
    let realRoot: string;
    try { realRoot = await fs.realpath(root); } catch { continue; }
    if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) return resolved;
  }
  return null;
}

export type SendKind = 'photo' | 'video' | 'voice' | 'audio' | 'document';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp']);
const VOICE_EXTS = new Set(['.ogg', '.opus']);   // sendVoice takes Opus/OGG
const AUDIO_EXTS = new Set(['.mp3', '.m4a']);     // sendAudio takes MP3/M4A

/** How a file should be sent. `isVoice` only turns an .ogg into a voice bubble
 *  when the tag asked; `forceDocument` sends images as files uncompressed. */
export function deliveryKind(filePath: string, opts: { isVoice?: boolean; forceDocument?: boolean } = {}): SendKind {
  const ext = path.extname(filePath).toLowerCase();
  if (VOICE_EXTS.has(ext)) return opts.isVoice ? 'voice' : 'document';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext) && !opts.forceDocument) return 'photo';
  return 'document';
}

export interface Deliverable { path: string; kind: SendKind }

/**
 * The whole job for a telegram reply: find the files the agent named, map their
 * container paths to host files, confine them to the session dir, and return
 * the cleaned text plus what to send. `toHost` maps `/workspace/X` →
 * `work/<session>/X`; `allowedRoots` are host dirs.
 */
export async function collectDeliverables(
  text: string, toHost: (p: string) => string, allowedRoots: string[],
): Promise<{ cleaned: string; files: Deliverable[] }> {
  const tagged = extractMedia(text);
  const bare = extractBarePaths(tagged.cleaned);
  const wanted: Media[] = [
    ...tagged.media,
    ...bare.paths.map((p) => ({ path: p, isVoice: false })),
  ];
  const files: Deliverable[] = [];
  const seen = new Set<string>();
  for (const w of wanted) {
    const host = await validateDeliveryPath(toHost(unquote(w.path)), allowedRoots);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    files.push({ path: host, kind: deliveryKind(host, { isVoice: w.isVoice, forceDocument: tagged.forceDocument }) });
  }
  return { cleaned: bare.cleaned, files };
}
