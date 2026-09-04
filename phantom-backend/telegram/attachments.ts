// What an inbound Telegram file IS, what to call it, where it lands, and what
// the agent is told. Decisions ported from ../shockwave
// (agent-core/attachmentPolicy.ts + attachmentNotes.ts), refit to sessions:
//
//  - Files land in the session's scratch dir — host `work/<id>/scratch/`,
//    container `/workspace/scratch/` — outside repo/, so auto-push's
//    commit-everything step never eats them. The note speaks CONTAINER paths:
//    that is the view the agent's file tools have.
//  - The note is IMPERATIVE — act on the file, ask only when the intent is
//    genuinely unclear. Passive wording made the model answer a message that
//    already said what to do with "what would you like me to do with this?".
//  - An image's type comes from its MAGIC BYTES, never the filename or the
//    sender's mime (a Telegram photo has neither). Bytes claiming to be an
//    image that aren't are refused.
//  - Small TEXT files are inlined, gated on the EXTENSION — never on whether
//    the bytes decode; PDF/zip/docx all open with decodable ASCII.
//  - There is no vision flag: the agent LOOKS at an image by reading it — the
//    `read` tool returns image files as image content the model can see.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Telegram's getFile ceiling for bots. Not ours, not raisable. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

/** Inline a text file's contents rather than pointing at it, up to this. */
export const MAX_TEXT_INLINE_BYTES = 100 * 1024;

// Extensions whose contents are safe to paste into the prompt — an EXTENSION
// gate, never "did the bytes decode".
export const TEXT_INLINE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.log',
  '.json', '.jsonl', '.ndjson', '.xml', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.properties',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.java', '.kt',
  '.go', '.rs', '.rb', '.php', '.pl', '.lua', '.r', '.jl',
  '.swift', '.m', '.scala', '.clj', '.ex', '.exs', '.erl',
  '.sql', '.graphql', '.proto', '.tf', '.hcl',
  '.dockerfile', '.makefile', '.cmake', '.gradle',
  '.rst', '.tex', '.srt', '.vtt', '.diff', '.patch',
]);

const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const AUDIO_EXTS = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.opus', '.flac']);
const MIME_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/** The image's real format, from its bytes — or null when it isn't one. */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length < 4) return null;
  if (data.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const head6 = data.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF'
    && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return null;
}

/** Strip anything that could escape the dir or confuse a shell. */
export function safeName(filename: string | undefined): string {
  let name = path.basename(String(filename ?? '')).replace(/\0/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  return name.replace(/[^\w.\- ]/g, '_');
}

/** image | video | audio | document; `defaultKind` breaks ties for a
 *  nameless upload (a native photo has neither name nor mime). `document`
 *  stays unbiased: Telegram uses it for anything from the file picker. */
export function classify(ext: string, mime: string | undefined, defaultKind?: MediaKind): MediaKind {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/') || ext in IMAGE_EXT_MIME || defaultKind === 'image') return 'image';
  if (m.startsWith('video/') || VIDEO_EXTS.has(ext) || defaultKind === 'video') return 'video';
  if (m.startsWith('audio/') || AUDIO_EXTS.has(ext) || defaultKind === 'audio') return 'audio';
  return 'document';
}

export interface StoredAttachment {
  /** CONTAINER path — what the note tells the agent, what its tools open. */
  containerPath: string;
  kind: MediaKind;
  displayName: string;
  /** Contents, for small text files; the note says so when set. */
  inlineText?: string;
}

/**
 * Write one attachment into the session's scratch dir. `scratchHostDir` is
 * the host view (`work/<id>/scratch`); the returned path is the container's.
 * Returns null when bytes claiming to be an image clearly aren't. Every
 * other type is accepted — the gate that matters is who may send files
 * (the one authorized user), not what they chose to send.
 */
export async function writeAttachment(
  scratchHostDir: string,
  data: Buffer,
  opts: { filename?: string; mimeType?: string; defaultKind?: MediaKind } = {},
): Promise<StoredAttachment | null> {
  const ext = path.extname(opts.filename ?? '').toLowerCase();
  const kind = classify(ext, opts.mimeType, opts.defaultKind);
  const sniffed = kind === 'image' ? sniffImageMime(data) : null;
  if (kind === 'image' && !sniffed) return null;

  const fallbackExt = ext
    || (sniffed && MIME_EXT[sniffed])
    || (kind === 'image' ? '.jpg' : kind === 'video' ? '.mp4' : kind === 'audio' ? '.ogg' : '.bin');
  const displayName = opts.filename ? safeName(opts.filename) : `${kind}${fallbackExt}`;
  const unique = crypto.randomBytes(6).toString('hex');
  const fileName = `${kind}_${unique}_${displayName}`;

  await fs.mkdir(scratchHostDir, { recursive: true });
  const target = path.join(scratchHostDir, fileName);
  // safeName stripped separators; this is the check that keeps a crafted
  // filename inside the dir if that ever changes.
  if (path.resolve(target) !== path.join(path.resolve(scratchHostDir), path.basename(target))) {
    throw new Error('rejected attachment filename');
  }
  await fs.writeFile(target, data);

  const out: StoredAttachment = {
    containerPath: `/workspace/scratch/${fileName}`, kind, displayName,
  };
  const resolvedMime = sniffed || opts.mimeType || '';
  if ((TEXT_INLINE_EXTS.has(ext) || resolvedMime.startsWith('text/')) && data.length <= MAX_TEXT_INLINE_BYTES) {
    try { out.inlineText = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { /* not text */ }
  }
  return out;
}

function note(a: StoredAttachment): string {
  if (a.kind === 'image') {
    return `[The user sent an image: '${a.displayName}'. It is saved at: ${a.containerPath}. `
      + 'Read that file with your read tool to LOOK at it before answering — do not guess at its contents.]';
  }
  if (a.kind === 'video') {
    return `[The user sent a video: '${a.displayName}'. It is saved at: ${a.containerPath}. `
      + 'Its content is not inlined here. If the request involves what the video contains, inspect or '
      + 'process it yourself — for example with a media tool in bash — instead of asking the user to '
      + 'describe it. Only ask what to do with it if their intent is genuinely unclear.]';
  }
  if (a.kind === 'audio') {
    return `[The user sent an audio file: '${a.displayName}'. It is saved at: ${a.containerPath}. `
      + 'Its content is not inlined here. If the request involves what the audio contains, transcribe or '
      + 'process it yourself instead of asking the user to describe it. Only ask what to do with it if '
      + 'their intent is genuinely unclear.]';
  }
  if (a.inlineText !== undefined) {
    return `[The user sent a text document: '${a.displayName}'. Its content is included below. `
      + `The file is also saved at: ${a.containerPath}]`;
  }
  return `[The user sent a document: '${a.displayName}'. It is saved at: ${a.containerPath}. `
    + "Its text is not inlined here (it's a binary format such as PDF or DOCX). Extract the text "
    + 'yourself — for example in bash — before answering, instead of asking the user to paste it.]';
}

/** Notes, then any inlined contents, then what the user actually typed. */
export function composeMessage(attachments: StoredAttachment[], userText: string): string {
  const notes = attachments.map(note);
  const inlined = attachments
    .filter((a) => a.inlineText !== undefined)
    .map((a) => `[Content of ${a.displayName}]:\n${a.inlineText}`);
  return [...notes, ...inlined, userText].filter((s) => s && s.trim()).join('\n\n');
}
