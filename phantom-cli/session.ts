// The coding session's transcript, on the shared format (core/llm/transcript.ts):
// one JSONL file per phantom session under CONFIG_DIR/sessions/. This file
// keeps only what is TUI-specific — where the files live, the coding header
// shape, and the resume-list helpers; the format itself (header line + one
// ModelMessage per line, torn-line tolerance, dangling-tool-call trim) lives
// with the other agents' transcript code.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import {
  Transcript as BaseTranscript, loadTranscriptFile, dropDanglingToolCall, lastUserFromJsonl,
  type LoadedTranscript, type TranscriptHeader as BaseHeader,
} from '../core/llm/transcript.js';

export { dropDanglingToolCall, type LoadedTranscript };

/** The coding session's header: the shared shape plus the session's identity. */
export interface TranscriptHeader extends BaseHeader {
  session_id: string;
  workspace: string;
  branch: string;
}

export const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');
export const transcriptPath = (sessionId: string) => join(SESSIONS_DIR, `${sessionId}.jsonl`);

export class Transcript extends BaseTranscript {
  constructor(header: TranscriptHeader, path = transcriptPath(header.session_id)) {
    super({ agent: 'coding', ...header }, path);
  }
}

export function loadTranscript(sessionId: string, file = transcriptPath(sessionId)): LoadedTranscript & { header?: TranscriptHeader } {
  return loadTranscriptFile(file) as LoadedTranscript & { header?: TranscriptHeader };
}

/** The last thing the user typed in a session, for the launcher's resume list.
 *  Read from the local transcript: cheaper than a title, always accurate, and
 *  it is what you actually recognise the conversation by. */
export function lastUserMessage(sessionId: string): string | undefined {
  const file = transcriptPath(sessionId);
  if (!existsSync(file)) return undefined;
  return lastUserFromJsonl(readFileSync(file, 'utf8'));
}

export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** What seating a session's transcript decided: the text the conversation
 *  opens from, and whether the LOCAL file was kept (server-text-plus-more) —
 *  the caller must then upload it, so the record catches up. */
export interface Seated { text: string; localKept: boolean }

/** Seat the conversation's working file from the SERVER's copy — the record.
 *  The one exception: a local file that IS the server's text with more lines
 *  after it. That is this machine's own unsaved steps — a window that died
 *  mid-turn appends every step as it runs and uploads only at turn end — and
 *  discarding them would lose work the server never had a chance to store
 *  (2026-09-04: a crash mid-turn, then reopen, emptied the only copy of an
 *  hour's conversation). Such a file is kept and reported so the caller
 *  uploads it. Anything else — no file, the same text, a file that matches
 *  only up to a point (both sides ran turns after the same moment: the saved
 *  ones win) — is replaced by the server's copy, an empty one included. */
export function adoptServerCopy(sessionId: string, raw: string | null, file = transcriptPath(sessionId)): Seated {
  const server = raw ?? '';
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    const local = readFileSync(file, 'utf8');
    if (local.length > server.length && local.startsWith(server)) return { text: local, localKept: true };
  }
  writeFileSync(file, server, { mode: 0o600 });
  return { text: server, localKept: false };
}

/** Push the local file up, whole — fired when a turn ends, in the background. */
export async function syncTranscriptUp(api: Api, sessionId: string, file = transcriptPath(sessionId)): Promise<string | null> {
  if (!existsSync(file)) return null;
  const r = await api('PUT', `/sessions/${sessionId}/transcript`, { data: readFileSync(file, 'utf8') }) as
    { updated_at?: string | null };
  // The server's stamp for what we just saved — the is-my-memory-current token.
  return r?.updated_at ?? null;
}

/** Session ids that have a transcript on this machine. */
export function localSessionIds(): Set<string> {
  if (!existsSync(SESSIONS_DIR)) return new Set();
  return new Set(readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length)));
}
