// Media — tracked files on S3-compatible storage (media/Media.ts). The
// service role's routes, like every /api route; user space builds its own
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
  organization: { type: 'string', description: 'The owning organization\'s id; absent = the service role\'s.' },
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

  app.get<{ Querystring: OwnerQuery & { limit?: number } }>('/media', { schema: { ...TAG, summary: 'List files',
    description: 'Stored files, newest first. Filter by project or by user.',
    querystring: { type: 'object', properties: { ...ownerProps, limit: { type: 'integer', minimum: 1, maximum: 1000 } } } } },
  async (req) => ok({ media: await backend.media.list({ organizationId: req.query.organization, projectId: req.query.project, userId: req.query.user, limit: req.query.limit }) }));

  app.get<{ Params: { id: string } }>('/media/:id', { schema: { ...TAG, summary: 'Get a file\'s details',
      description: 'One stored file\'s name, type, size and owner.', params: idParam } },
    async (req, reply) => {
      try { return ok(await backend.media.get(req.params.id)); } catch (error) { return refuse(reply, error); }
    });

  app.post<{ Querystring: OwnerQuery & { name: string; type?: string } }>('/media', { schema: { ...TAG, summary: 'Upload a file',
    description: 'Uploads a file through the server: the request body is the file itself. Returns the stored file.',
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

  app.post<{ Body: OwnerQuery & { name: string; size: number; type: string } }>('/media/uploads', { schema: { ...TAG, summary: 'Start a direct upload',
    description: 'For a browser uploading straight to storage: returns the file record and where to send the bytes (several addresses, for a large file).',
    body: { type: 'object', required: ['name', 'size', 'type'], additionalProperties: false, properties: {
      ...ownerProps, name: { type: 'string', minLength: 1, maxLength: 255 }, size: { type: 'integer', minimum: 1 }, type: { type: 'string', minLength: 3 } } } } },
  async (req, reply) => {
    try {
      const started = await backend.media.createUpload({ name: req.body.name, size: req.body.size, mimeType: req.body.type, owner: ownerOf(req.body) });
      return reply.code(201).send(ok(started));
    } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: { parts?: { partNumber: number; etag: string }[] } }>('/media/:id/complete', { schema: { ...TAG, summary: 'Finish a direct upload',
    description: 'Called once a direct upload\'s bytes are sent. Checks the file and marks it ready.',
    params: idParam,
    body: { type: 'object', additionalProperties: false, properties: { parts: { type: 'array', items: { type: 'object', required: ['partNumber', 'etag'],
      additionalProperties: false, properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, etag: { type: 'string', minLength: 1 } } } } } } } },
  async (req, reply) => {
    try { return ok(await backend.media.complete(req.params.id, { parts: req.body?.parts })); } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Body: { ids: string[]; seconds?: number } }>('/media/links', { schema: { ...TAG, summary: 'Get download links',
    description: 'Short-lived download links for one or more files.',
    body: { type: 'object', required: ['ids'], additionalProperties: false, properties: {
      ids: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string' } }, seconds: { type: 'integer', minimum: 60 } } } } },
  async (req, reply) => {
    try { return ok({ links: await backend.media.links(req.body.ids, { seconds: req.body.seconds }) }); } catch (error) { return refuse(reply, error); }
  });

  app.get<{ Params: { id: string }; Querystring: { seconds?: number } }>('/media/:id/content', { schema: { ...TAG, summary: 'Download a file',
    description: 'Redirects to a short-lived download link for the file.',
    params: idParam, querystring: { type: 'object', properties: { seconds: { type: 'integer', minimum: 60 } } } } },
  async (req, reply) => {
    try {
      const [link] = await backend.media.links([req.params.id], { seconds: req.query.seconds });
      return reply.header('cache-control', 'private, no-store').redirect(link.url, 302);
    } catch (error) { return refuse(reply, error); }
  });

  app.delete<{ Params: { id: string } }>('/media/:id', { schema: { ...TAG, summary: 'Delete a file', params: idParam,
    description: 'Deletes a stored file and its contents.' } },
  async (req, reply) => {
    try { await backend.media.delete(req.params.id); return ok({}); } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Body: { origins: string[]; organization?: string } }>('/media/setup', { config: { serviceRole: true }, schema: { ...TAG, summary: 'Allow browser uploads',
    description: 'Sets up the storage bucket so web apps on the given origins can upload to it and read from it directly.',
    body: { type: 'object', required: ['origins'], additionalProperties: false, properties: {
      origins: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^https?://' } }, organization: ownerProps.organization } } } },
  async (req, reply) => {
    try { return ok(await backend.media.setup(req.body.origins, req.body.organization ?? null)); } catch (error) { return refuse(reply, error); }
  });
}
