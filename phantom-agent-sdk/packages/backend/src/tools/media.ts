// The MEDIA tools — media_list, media_link, media_download, media_upload:
// the project's organization's tracked files (media/Media.ts). Offered when
// agent_media is on for the project and media is configured for its
// organization. The agent never holds a
// storage key: a link is short-lived, and downloads and uploads run here,
// between the bucket and the session's /workspace.
import path from 'node:path';
import fs from 'node:fs/promises';
import { sessionDir } from '../lib/paths.js';
import { scopeOf } from '../lib/scopes.js';
import { workspaceOf } from '../storage/Sessions.js';
import { MediaError, type MediaRow } from '../media/Media.js';
import { int, obj, refusal, str, type OfferCtx, type ToolCtx, type ToolDef } from './def.js';

const CONTAINER_ROOT = '/workspace';

const configured = async (ctx: OfferCtx) =>
  Boolean(await ctx.app.settings.resolve('agent_media', scopeOf(ctx.project))) && await ctx.app.media.configured(ctx.project.organizationId);
const withFiles = async (ctx: OfferCtx) => Boolean(ctx.session.workspaceId) && await configured(ctx);
const hostRoot = (ctx: ToolCtx) => sessionDir(ctx.app.paths, workspaceOf(ctx.session));

const brief = (row: MediaRow) => ({ id: row.id, name: row.name, type: row.mimeType, size: row.size, created_at: row.createdAt.toISOString() });

/** A MediaError as the refusal the model reads; anything else is a bug and throws on. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof MediaError) throw refusal(error.code, error.message);
    throw error;
  }
}

export const MEDIA_TOOLS: ToolDef[] = [
  {
    name: 'media_list',
    summary: 'The tracked media files — names, types, sizes, ids.',
    description: 'The media files kept for this project\'s organization (videos, images, audio, documents), newest first. ' +
      'Use an id with media_link or media_download.',
    input: obj({ limit: int('how many, newest first', 50) }),
    mutates: false, group: 'media', offered: configured,
    async execute(ctx, a) {
      const rows = await ctx.app.media.list({ organizationId: ctx.project.organizationId, limit: typeof a.limit === 'number' ? a.limit : 50 });
      return { media: rows.map(brief) };
    },
  },
  {
    name: 'media_link',
    summary: 'A short-lived download link for one media file.',
    description: 'A link that serves the file for a limited time, then stops working. Hand it to tools that read a URL directly ' +
      '(ffmpeg -i "<link>", ffprobe, curl) instead of downloading a large file first, or give it to a person. ' +
      'Ask for `seconds` long enough for the job — a link that expires mid-job fails it.',
    input: obj({ id: str('the media file\'s id (media_list)'), seconds: int('how long the link works') }, ['id']),
    mutates: false, group: 'media', offered: configured,
    async execute(ctx, a) {
      const [link] = await refusing(() => ctx.app.media.links([String(a.id)], {
        organizationId: ctx.project.organizationId, ...(typeof a.seconds === 'number' ? { seconds: a.seconds } : {}) }));
      return { url: link.url, expires_at: link.expiresAt };
    },
  },
  {
    name: 'media_download',
    summary: 'Copy a media file into /workspace/scratch.',
    description: 'Copies one media file into /workspace/scratch and answers its path — for work that reads the file more than once, ' +
      'or for longer than a link would last.',
    input: obj({ id: str('the media file\'s id (media_list)') }, ['id']),
    mutates: true, group: 'media', offered: withFiles,
    async execute(ctx, a) {
      const hostPath = await refusing(() => ctx.app.media.download(String(a.id), path.join(hostRoot(ctx), 'scratch'), ctx.project.organizationId));
      return { path: path.posix.join(CONTAINER_ROOT, 'scratch', path.basename(hostPath)) };
    },
  },
  {
    name: 'media_upload',
    summary: 'Keep a file from /workspace as a tracked media file.',
    description: 'Uploads a file you made (a rendered video, an image, a report) to media storage as this project\'s organization\'s file, ' +
      'and answers its id. Only file types the media settings allow are kept. Re-encode video for streaming first: ffmpeg … -movflags +faststart.',
    input: obj({ path: str('the file, under /workspace'), name: str('the name people see; default the file\'s own') }, ['path']),
    mutates: true, group: 'media', offered: withFiles,
    async execute(ctx, a) {
      const wanted = path.posix.normalize(String(a.path));
      if (wanted !== CONTAINER_ROOT && !wanted.startsWith(`${CONTAINER_ROOT}/`)) throw refusal('invalid_args', `path must be under ${CONTAINER_ROOT}`);
      const root = hostRoot(ctx);
      const hostPath = path.join(root, wanted.slice(CONTAINER_ROOT.length));
      // The real file must still be inside the workspace once links are followed.
      const real = await fs.realpath(hostPath).catch(() => null);
      if (!real || !real.startsWith(`${await fs.realpath(root)}${path.sep}`)) throw refusal('not_found', `no file at ${wanted}`);
      const row = await refusing(() => ctx.app.media.uploadFile(real, {
        ...(typeof a.name === 'string' && a.name.trim() ? { name: a.name } : { name: path.basename(wanted) }),
        owner: { organizationId: ctx.project.organizationId, projectId: ctx.project.id, sessionId: ctx.session.id },
      }));
      return brief(row);
    },
  },
];
