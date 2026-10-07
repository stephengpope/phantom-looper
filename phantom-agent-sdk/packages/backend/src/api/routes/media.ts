// Media — tracked files on S3-compatible storage (media/Media.ts). The
// phantom admin's routes, like every /api route; user space builds its own
// users' routes under /app on backend.media with its own rules.
//
//   GET    /media                    ?organization=&project=&user=&limit=  → ready files
//   GET    /media/:id                                                     → one file
//   POST   /media                    raw bytes (application/octet-stream) ?name=&type=&organization=&project=&user=
//   POST   /media/uploads            { name, size, type, organization?, project?, user? } → { media, upload }
//   POST   /media/:id/complete       { parts? }                           → the file, ready
//   POST   /media/links              { ids, seconds? }                    → { links }
//   GET    /media/:id/content        ?seconds=                            → 302 to a link
//   DELETE /media/:id
//   POST   /media/setup              { origins, organization? }           → the bucket's CORS rule
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ok, err } from '../HttpApi.js';
import { MediaError } from '../../media/Media.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const TAG = { tags: ['media'] };
const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const ownerProps = {
  organization: { type: 'string', description: 'The owning organization\'s id; absent = the phantom admin\'s.' },
  project: { type: 'string', description: 'The project the file belongs to, if any.' },
  user: { type: 'string', description: 'The user the file belongs to or was uploaded by, if any.' },
};
type OwnerQuery = { organization?: string; project?: string; user?: string };

const STATUS: Record<MediaError['code'], number> = {
  not_configured: 409, not_found: 404, invalid_args: 400, too_large: 413, type_not_allowed: 415,
  not_uploading: 409, storage_changed: 409, storage_failed: 502,
};

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof MediaError) return reply.code(STATUS[error.code]).send(err(`media_${error.code}`, error.message, error.code === 'storage_failed'));
  throw error;
}

const ownerOf = (query: OwnerQuery) => ({ organizationId: query.organization ?? null, projectId: query.project ?? null, userId: query.user ?? null });

export function mediaRoutes(app: FastifyInstance, backend: PhantomBackend) {
  // The bytes of POST /media arrive as a stream, handed over unread:
  // Media.upload counts them against the size limit as they pass.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get<{ Querystring: OwnerQuery & { limit?: number } }>('/media', { schema: { ...TAG, summary: 'List media files',
    description: 'Ready files, newest first. Each filter narrows: `organization` (absent = every organization\'s), `project`, `user`.',
    querystring: { type: 'object', properties: { ...ownerProps, limit: { type: 'integer', minimum: 1, maximum: 1000 } } } } },
  async (req) => ok({ media: await backend.media.list({ organizationId: req.query.organization, projectId: req.query.project, userId: req.query.user, limit: req.query.limit }) }));

  app.get<{ Params: { id: string } }>('/media/:id', { schema: { ...TAG, summary: 'One media file', params: idParam } },
    async (req, reply) => {
      try { return ok(await backend.media.get(req.params.id)); } catch (error) { return refuse(reply, error); }
    });

  app.post<{ Querystring: OwnerQuery & { name: string; type?: string } }>('/media', { schema: { ...TAG, summary: 'Upload a file through this server',
    description: 'The body is the file\'s bytes (content-type application/octet-stream), streamed to storage as they arrive. `name` is the file\'s name; ' +
      '`type` what the sender believes it is — the type stored is read from the bytes. Answers the ready file; 413 over media_max_bytes, 415 a type media_allowed_types does not list.',
    querystring: { type: 'object', required: ['name'], properties: { ...ownerProps, name: { type: 'string', minLength: 1, maxLength: 255 }, type: { type: 'string' } } } } },
  async (req, reply) => {
    const aborted = new AbortController();
    req.raw.on('close', () => { if (!req.raw.complete) aborted.abort(); });
    const length = Number(req.headers['content-length']);
    try {
      const row = await backend.media.upload(req.body as Readable, {
        name: req.query.name, owner: ownerOf(req.query), mimeType: req.query.type,
        ...(Number.isFinite(length) && length > 0 ? { size: length } : {}), signal: aborted.signal,
      });
      return reply.code(201).send(ok(row));
    } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Body: OwnerQuery & { name: string; size: number; type: string } }>('/media/uploads', { schema: { ...TAG, summary: 'Start a browser upload',
    description: 'For a browser sending the bytes straight to storage. Answers the file (status uploading) and `upload`: ' +
      '`{ mode: "single", url, headers }` — one PUT of the whole file with those headers; or `{ mode: "multipart", partSize, parts: [{ partNumber, url }] }` — ' +
      'one PUT per part, each exactly partSize bytes but the last, keeping each answer\'s ETag header. Then POST /media/:id/complete. The bucket needs a CORS rule for the browser\'s origin (POST /media/setup).',
    body: { type: 'object', required: ['name', 'size', 'type'], additionalProperties: false, properties: {
      ...ownerProps, name: { type: 'string', minLength: 1, maxLength: 255 }, size: { type: 'integer', minimum: 1 }, type: { type: 'string', minLength: 3 } } } } },
  async (req, reply) => {
    try {
      const started = await backend.media.createUpload({ name: req.body.name, size: req.body.size, mimeType: req.body.type, owner: ownerOf(req.body) });
      return reply.code(201).send(ok(started));
    } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: { parts?: { partNumber: number; etag: string }[] } }>('/media/:id/complete', { schema: { ...TAG, summary: 'Finish a browser upload',
    description: 'After the browser\'s PUTs: a multipart upload sends `parts` — every part\'s number and the ETag its PUT answered. The file\'s real size and type are checked; ' +
      'a file that fails is deleted (413, 415).',
    params: idParam,
    body: { type: 'object', additionalProperties: false, properties: { parts: { type: 'array', items: { type: 'object', required: ['partNumber', 'etag'],
      additionalProperties: false, properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, etag: { type: 'string', minLength: 1 } } } } } } } },
  async (req, reply) => {
    try { return ok(await backend.media.complete(req.params.id, { parts: req.body?.parts })); } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Body: { ids: string[]; seconds?: number } }>('/media/links', { schema: { ...TAG, summary: 'Download links',
    description: 'A link for each file, in order: works for `seconds` (default media_link_seconds, at most media_link_max_seconds), then dies. ' +
      'Made here with no call to storage, so a page of files is one request; the same link comes back while most of its life is left, so a browser keeps its cached copy.',
    body: { type: 'object', required: ['ids'], additionalProperties: false, properties: {
      ids: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string' } }, seconds: { type: 'integer', minimum: 60 } } } } },
  async (req, reply) => {
    try { return ok({ links: await backend.media.links(req.body.ids, { seconds: req.body.seconds }) }); } catch (error) { return refuse(reply, error); }
  });

  app.get<{ Params: { id: string }; Querystring: { seconds?: number } }>('/media/:id/content', { schema: { ...TAG, summary: 'Open a file',
    description: 'Redirects (302) to a download link — the bytes come from storage, ranges and all, so video seeks.',
    params: idParam, querystring: { type: 'object', properties: { seconds: { type: 'integer', minimum: 60 } } } } },
  async (req, reply) => {
    try {
      const [link] = await backend.media.links([req.params.id], { seconds: req.query.seconds });
      return reply.header('cache-control', 'private, no-store').redirect(link.url, 302);
    } catch (error) { return refuse(reply, error); }
  });

  app.delete<{ Params: { id: string } }>('/media/:id', { schema: { ...TAG, summary: 'Delete a file', params: idParam,
    description: 'Its bytes in storage, then its record. An unfinished upload is aborted.' } },
  async (req, reply) => {
    try { await backend.media.delete(req.params.id); return ok({}); } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Body: { origins: string[]; organization?: string } }>('/media/setup', { schema: { ...TAG, summary: 'Let browsers reach the bucket',
    description: 'Sets the bucket\'s CORS rule so web apps on `origins` can upload straight to it and play from it. A provider that only takes this in its own ' +
      'dashboard answers `cors: "unsupported"` with the rule to enter there.',
    body: { type: 'object', required: ['origins'], additionalProperties: false, properties: {
      origins: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^https?://' } }, organization: ownerProps.organization } } } },
  async (req, reply) => {
    try { return ok(await backend.media.setup(req.body.origins, req.body.organization ?? null)); } catch (error) { return refuse(reply, error); }
  });
}
