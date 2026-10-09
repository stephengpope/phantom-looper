// Media — tracked files on S3-compatible storage, and the one owner of the
// `media` table (058). The server's owner brings any S3-compatible provider
// (AWS, R2, B2, Wasabi, Hetzner, a self-hosted server) through five
// settings; an organization that sets all of them at its own layer keeps
// its files in its own bucket. Settings are read per call: a change applies
// with no restart.
//
// Only the calls every provider implements: Head/Get/Put/Delete object,
// multipart create/part/complete/abort, presigned GET/PUT/UploadPart, and
// PutBucketCors at setup (refused by some — said so, nothing else depends
// on it). Checksums are left to the provider (`WHEN_REQUIRED`): the AWS
// SDK's default checksum headers break most non-AWS providers.
//
// Three ways in, one way to `ready`:
//   - upload(stream)   — through this server, streamed (lib-storage)
//   - createUpload()   — straight from the browser: one presigned PUT, or a
//                        presigned multipart upload for a large file
//   - complete()       — the browser says it is done
// Every one ends in #verify: the object's real size from the provider, its
// type from its first bytes (file-type), both checked against the limits.
// A file that fails is deleted. Nothing trusts what the uploader claimed.
//
// Out: links — presigned GETs, short-lived, every file private. A link is
// a signature computed here (no call to the provider), so a page's worth
// is one call.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import {
  S3Client, HeadBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { fileTypeFromBuffer } from 'file-type';
import { newId } from '@phantom-agent-sdk/client';
import type { Drizzle } from '../storage/Database.js';
import type { Settings } from '../storage/Settings.js';
import { media, type MediaRow } from '../storage/schema.js';
import { logger, errStr } from '../lib/log.js';
import { SERVICE_ROLE_ORGANIZATION } from '../lib/scopes.js';

export type { MediaRow };

const log = logger('media');

export class MediaError extends Error {
  constructor(readonly code: 'not_configured' | 'not_found' | 'invalid_args' | 'too_large' | 'type_not_allowed'
    | 'not_uploading' | 'storage_changed' | 'storage_failed', message: string) { super(message); this.name = 'MediaError'; }
}

/** Who a file belongs to. `organizationId` null = the service role's (SERVICE_ROLE_ORGANIZATION). */
export interface MediaOwner {
  organizationId: string | null;
  userId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
}

/** How a browser sends the bytes: one PUT, or one PUT per part. */
export type UploadPlan =
  | { mode: 'single'; url: string; headers: Record<string, string> }
  | { mode: 'multipart'; partSize: number; parts: { partNumber: number; url: string }[] };

export interface MediaLink { id: string; url: string; expiresAt: string }

/** Up to this size a browser sends one PUT; above it, parts. */
const SINGLE_PUT_MAX = 100 * 1024 ** 2;
/** Part size: 16 MiB, or bigger when a file would need more than the 10,000 parts S3 allows. */
const PART_SIZE = 16 * 1024 ** 2;
const MAX_PARTS = 10_000;
/** How long a browser has to start sending once it has its upload URLs. */
const UPLOAD_URL_SECONDS = 3600;
/** An upload not completed in this long is abandoned: swept with its bytes. */
const ABANDONED_MS = 24 * 3600_000;
/** What #verify reads to tell the type — file-type's own sample size. */
const SNIFF_BYTES = 4100;
/** Types a browser may show in place; anything else downloads. */
const INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/;

interface Storage { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }

const STORAGE_KEYS = ['media_endpoint', 'media_region', 'media_bucket'] as const;

export class Media {
  /** One client per storage, made once: the address style is found on the first call. */
  #clients = new Map<string, Promise<S3Client>>();
  /** Links handed out, reused while at least half their life is left — the
   *  same URL lets a browser keep its cached copy. */
  #links = new Map<string, { url: string; expiresAt: number }>();

  constructor(private readonly database: Drizzle, private readonly settings: Settings) {}

  // ── storage ──────────────────────────────────────────────────────────

  /** The storage an organization's NEW files go to: its own when it set
   *  endpoint, bucket and both keys at its layer, else the server's. */
  async #storageFor(organizationId: string | null): Promise<Storage> {
    if (organizationId) {
      const own = await this.#storageAt({ organizationId }, 'organization');
      if (own) return own;
    }
    const global = await this.#storageAt({}, 'global');
    if (!global) throw new MediaError('not_configured', 'media is not configured: set media_endpoint, media_bucket, media_access_key_id and media_secret_access_key');
    return global;
  }

  async #storageAt(scope: { organizationId?: string }, layer: 'global' | 'organization'): Promise<Storage | null> {
    const values = await this.settings.resolveMany(STORAGE_KEYS, scope);
    const keys = (await this.settings.credentialLayers(scope));
    const accessKeyId = keys.media_access_key_id?.[layer];
    const secretAccessKey = keys.media_secret_access_key?.[layer];
    if (layer === 'organization') {
      const endpointAt = (await this.settings.resolveWithSource('media_endpoint', scope)).source;
      const bucketAt = (await this.settings.resolveWithSource('media_bucket', scope)).source;
      if (endpointAt !== 'organization' || bucketAt !== 'organization') return null;
    }
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const endpoint = text(values.media_endpoint); const bucket = text(values.media_bucket);
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    return { endpoint, region: text(values.media_region) || 'auto', bucket, accessKeyId, secretAccessKey };
  }

  /** The storage a file already written lives in — the organization's or
   *  the server's, whichever still names its endpoint and bucket. */
  async #storageOf(row: MediaRow): Promise<Storage> {
    const candidates = [row.organizationId ? await this.#storageAt({ organizationId: row.organizationId }, 'organization') : null, await this.#storageAt({}, 'global')];
    const found = candidates.find((storage) => storage && storage.endpoint === row.endpoint && storage.bucket === row.bucket);
    if (!found) throw new MediaError('storage_changed', `${row.name} is in ${row.endpoint} bucket ${row.bucket}, which is no longer configured`);
    return found;
  }

  /** Is media usable for this organization's new files? */
  async configured(organizationId: string | null = null): Promise<boolean> {
    return this.#storageFor(organizationId).then(() => true, () => false);
  }

  /** The client for a storage. Address style: a bucket in the hostname
   *  (bucket.host/key) where the provider answers to it, else in the path
   *  (host/bucket/key) — what an IP address or a self-hosted server needs.
   *  Found once per storage with a HeadBucket, which also proves the keys. */
  #client(storage: Storage): Promise<S3Client> {
    const id = [storage.endpoint, storage.region, storage.bucket, storage.accessKeyId, storage.secretAccessKey].join('\n');
    let client = this.#clients.get(id);
    if (!client) {
      client = this.#connect(storage);
      client.catch(() => this.#clients.delete(id));
      this.#clients.set(id, client);
    }
    return client;
  }

  async #connect(storage: Storage): Promise<S3Client> {
    const make = (forcePathStyle: boolean) => new S3Client({
      endpoint: storage.endpoint, region: storage.region, forcePathStyle,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000, requestTimeout: 120_000,
        httpAgent: new http.Agent({ keepAlive: true, maxSockets: 200 }),
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 200 }),
      }),
    });
    const host = new URL(storage.endpoint).hostname;
    const pathOnly = host === 'localhost' || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':');
    if (!pathOnly) {
      const virtual = make(false);
      try {
        await virtual.send(new HeadBucketCommand({ Bucket: storage.bucket }));
        return virtual;
      } catch { virtual.destroy(); }
    }
    const pathStyle = make(true);
    try {
      await pathStyle.send(new HeadBucketCommand({ Bucket: storage.bucket }));
      return pathStyle;
    } catch (error) {
      pathStyle.destroy();
      throw new MediaError('storage_failed', `cannot reach bucket ${storage.bucket} at ${storage.endpoint}: ${providerWords(error)}`);
    }
  }

  // ── reading rows ─────────────────────────────────────────────────────

  /** One file. With `organizationId` given (null = the service role's),
   *  another organization's file is not found. */
  async get(id: string, organizationId?: string | null): Promise<MediaRow> {
    const [row] = await this.database.select().from(media).where(eq(media.id, id));
    if (!row || (organizationId !== undefined && row.organizationId !== (organizationId ?? SERVICE_ROLE_ORGANIZATION))) throw new MediaError('not_found', `no media file ${id}`);
    return row;
  }

  /** Ready files, newest first. Each filter given narrows; `organizationId` null = the service role's. */
  async list(filter: { organizationId?: string | null; projectId?: string; userId?: string; limit?: number } = {}): Promise<MediaRow[]> {
    const where: SQL[] = [eq(media.status, 'ready')];
    if (filter.organizationId !== undefined) where.push(eq(media.organizationId, filter.organizationId ?? SERVICE_ROLE_ORGANIZATION));
    if (filter.projectId) where.push(eq(media.projectId, filter.projectId));
    if (filter.userId) where.push(eq(media.userId, filter.userId));
    return this.database.select().from(media).where(and(...where)).orderBy(desc(media.createdAt)).limit(Math.min(filter.limit ?? 100, 1000));
  }

  /** Files of an organization, any status — what refuses its deletion. */
  async ofOrganization(organizationId: string): Promise<number> {
    return (await this.database.select({ id: media.id }).from(media).where(eq(media.organizationId, organizationId)).limit(1)).length;
  }

  // ── uploads ──────────────────────────────────────────────────────────

  /** Upload through this server: the stream goes to the bucket as it
   *  arrives (multipart, 16 MiB parts, four in flight — memory stays
   *  bounded), counted against the size limit; then verified. `signal`
   *  aborts it (the uploader hung up). */
  async upload(body: Readable, options: { name: string; owner: MediaOwner; mimeType?: string; size?: number; signal?: AbortSignal }): Promise<MediaRow> {
    const limits = await this.#limits(options.owner.organizationId);
    if (options.size !== undefined && options.size > limits.maxBytes) throw tooLarge(options.size, limits.maxBytes);
    const row = await this.#create(options.owner, options.name, options.mimeType ?? 'application/octet-stream', options.size ?? 0);
    const storage = await this.#storageOf(row);
    try {
      let counted = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          counted += chunk.length;
          done(counted > limits.maxBytes ? tooLarge(counted, limits.maxBytes) : null, chunk);
        },
      });
      const upload = new Upload({
        client: await this.#client(storage), partSize: PART_SIZE, queueSize: 4, leavePartsOnError: false,
        params: { Bucket: row.bucket, Key: row.key, Body: body.pipe(counter), ContentType: row.mimeType },
      });
      body.on('error', (error) => counter.destroy(error));
      const failed = new Promise<never>((_resolve, reject) => counter.on('error', reject));
      failed.catch(() => {});
      const stop = () => { void upload.abort(); };
      options.signal?.addEventListener('abort', stop, { once: true });
      try {
        await Promise.race([upload.done(), failed]);
      } catch (error) {
        await upload.abort().catch(() => {});
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', stop);
      }
      return await this.#verify(row, storage, null);
    } catch (error) {
      await this.#discard(row, storage);
      if (error instanceof MediaError) throw error;
      throw new MediaError('storage_failed', `upload of ${options.name} failed: ${providerWords(error)}`);
    }
  }

  /** Upload a file on this server's disk (an agent's output). */
  async uploadFile(filePath: string, options: { name?: string; owner: MediaOwner; mimeType?: string }): Promise<MediaRow> {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new MediaError('not_found', `no file at ${filePath}`);
    return this.upload(fs.createReadStream(filePath), { name: options.name ?? path.basename(filePath), owner: options.owner, mimeType: options.mimeType, size: stat.size });
  }

  /** Start a browser upload: the row, and the presigned URLs the browser
   *  sends the bytes to. The size and type are checked now and again on
   *  complete; each URL is signed for its exact length, so the provider
   *  refuses more bytes than were declared. */
  async createUpload(options: { name: string; size: number; mimeType: string; owner: MediaOwner }): Promise<{ media: MediaRow; upload: UploadPlan }> {
    const limits = await this.#limits(options.owner.organizationId);
    if (!Number.isInteger(options.size) || options.size < 1) throw new MediaError('invalid_args', 'size must be the file\'s length in bytes');
    if (options.size > limits.maxBytes) throw tooLarge(options.size, limits.maxBytes);
    if (!typeAllowed(options.mimeType, limits.allowed)) throw notAllowed(options.mimeType, limits.allowed);
    const row = await this.#create(options.owner, options.name, options.mimeType, options.size);
    const storage = await this.#storageOf(row);
    try {
      const client = await this.#client(storage);
      if (options.size <= SINGLE_PUT_MAX) {
        const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: row.bucket, Key: row.key, ContentType: row.mimeType, ContentLength: row.size }),
          { expiresIn: UPLOAD_URL_SECONDS, signableHeaders: new Set(['content-type']) });
        return { media: row, upload: { mode: 'single', url, headers: { 'content-type': row.mimeType } } };
      }
      const partSize = Math.max(PART_SIZE, Math.ceil(row.size / MAX_PARTS / 1024 ** 2) * 1024 ** 2);
      const count = Math.ceil(row.size / partSize);
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: row.bucket, Key: row.key, ContentType: row.mimeType }));
      if (!created.UploadId) throw new Error('the provider gave no upload id');
      await this.database.update(media).set({ uploadId: created.UploadId, updatedAt: new Date() }).where(eq(media.id, row.id));
      const parts = await Promise.all(Array.from({ length: count }, async (_unused, i) => ({
        partNumber: i + 1,
        url: await getSignedUrl(client, new UploadPartCommand({ Bucket: row.bucket, Key: row.key, UploadId: created.UploadId, PartNumber: i + 1,
          ContentLength: i + 1 < count ? partSize : row.size - partSize * (count - 1) }), { expiresIn: UPLOAD_URL_SECONDS }),
      })));
      return { media: { ...row, uploadId: created.UploadId }, upload: { mode: 'multipart', partSize, parts } };
    } catch (error) {
      await this.#discard(row, storage);
      throw new MediaError('storage_failed', `could not start the upload of ${options.name}: ${providerWords(error)}`);
    }
  }

  /** The browser sent everything: finish a multipart upload (its parts'
   *  ETags, as each part's PUT answered them), then verify. */
  async complete(id: string, options: { organizationId?: string | null; parts?: { partNumber: number; etag: string }[] } = {}): Promise<MediaRow> {
    const row = await this.get(id, options.organizationId);
    if (row.status !== 'uploading') throw new MediaError('not_uploading', `${row.name} is already uploaded`);
    const storage = await this.#storageOf(row);
    if (row.uploadId) {
      if (!options.parts?.length) throw new MediaError('invalid_args', 'a multipart upload completes with its parts: [{ partNumber, etag }]');
      try {
        const client = await this.#client(storage);
        await client.send(new CompleteMultipartUploadCommand({ Bucket: row.bucket, Key: row.key, UploadId: row.uploadId,
          MultipartUpload: { Parts: [...options.parts].sort((a, b) => a.partNumber - b.partNumber).map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }));
      } catch (error) {
        throw new MediaError('storage_failed', `could not finish the upload of ${row.name}: ${providerWords(error)}`);
      }
    }
    try {
      return await this.#verify(row, storage, row.size);
    } catch (error) {
      await this.#discard(row, storage);
      throw error;
    }
  }

  /** The real size and type, from the provider and the file's first bytes;
   *  `ready` when both pass. `expectedSize`: what a browser upload declared. */
  async #verify(row: MediaRow, storage: Storage, expectedSize: number | null): Promise<MediaRow> {
    const limits = await this.#limits(row.organizationId);
    const client = await this.#client(storage);
    let size: number;
    let head: Uint8Array;
    try {
      size = Number((await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: row.key }))).ContentLength ?? 0);
      const sample = await client.send(new GetObjectCommand({ Bucket: row.bucket, Key: row.key, Range: `bytes=0-${SNIFF_BYTES - 1}` }));
      head = sample.Body ? await sample.Body.transformToByteArray() : new Uint8Array();
    } catch (error) {
      throw new MediaError('storage_failed', `could not check ${row.name}: ${providerWords(error)}`);
    }
    if (expectedSize !== null && size !== expectedSize) throw new MediaError('invalid_args', `${row.name} arrived as ${size} bytes, not the ${expectedSize} declared`);
    if (size > limits.maxBytes) throw tooLarge(size, limits.maxBytes);
    if (size === 0) throw new MediaError('invalid_args', `${row.name} is empty`);
    // Binary formats announce themselves in their first bytes. Text cannot:
    // a text/* claim stands only when the bytes are text; anything else
    // unrecognised is unknown binary.
    const detected = (await fileTypeFromBuffer(head))?.mime;
    const mimeType = detected ?? (row.mimeType.startsWith('text/') && isText(head) ? row.mimeType : 'application/octet-stream');
    if (!typeAllowed(mimeType, limits.allowed)) throw notAllowed(mimeType, limits.allowed);
    const [ready] = await this.database.update(media).set({ status: 'ready', size, mimeType, uploadId: null, updatedAt: new Date() })
      .where(eq(media.id, row.id)).returning();
    log.info({ media: row.id, size, mimeType }, 'media ready');
    return ready;
  }

  async #create(owner: MediaOwner, name: string, mimeType: string, size: number): Promise<MediaRow> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 255) throw new MediaError('invalid_args', 'name must be 1–255 characters');
    const storage = await this.#storageFor(owner.organizationId);
    const id = newId();
    // The organization's namespace; the file's own id. The user's name for
    // it is in the row, never in the key.
    const organizationId = owner.organizationId ?? SERVICE_ROLE_ORGANIZATION;
    const key = `org/${organizationId}/${id}`;
    const [row] = await this.database.insert(media).values({
      id, organizationId, userId: owner.userId ?? null, projectId: owner.projectId ?? null, sessionId: owner.sessionId ?? null,
      name: trimmed, mimeType, size, endpoint: storage.endpoint, bucket: storage.bucket, key,
    }).returning();
    return row;
  }

  /** The bytes and the row of a file that will not become ready. Best
   *  effort at the provider: the sweep and the row's absence settle the rest. */
  async #discard(row: MediaRow, storage: Storage): Promise<void> {
    try {
      const client = await this.#client(storage);
      const [current] = await this.database.select({ uploadId: media.uploadId }).from(media).where(eq(media.id, row.id));
      if (current?.uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: row.bucket, Key: row.key, UploadId: current.uploadId })).catch(() => {});
      await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.key }));
    } catch (error) {
      log.warn({ media: row.id, err: errStr(error) }, 'could not remove the bytes of a discarded media file');
    }
    await this.database.delete(media).where(eq(media.id, row.id));
  }

  async #limits(organizationId: string | null): Promise<{ maxBytes: number; allowed: string[] }> {
    const scope = organizationId ? { organizationId } : {};
    const values = await this.settings.resolveMany(['media_max_bytes', 'media_allowed_types'], scope);
    return { maxBytes: Number(values.media_max_bytes), allowed: (typeof values.media_allowed_types === 'string' ? values.media_allowed_types : '').split(',').map((type) => type.trim().toLowerCase()).filter(Boolean) };
  }

  // ── out ──────────────────────────────────────────────────────────────

  /** Download links for ready files, in the order asked. `seconds`: how
   *  long they work (default media_link_seconds, at most
   *  media_link_max_seconds). Another organization's file is not found. */
  async links(ids: string[], options: { organizationId?: string | null; seconds?: number } = {}): Promise<MediaLink[]> {
    const out: MediaLink[] = [];
    for (const id of ids) {
      const row = await this.get(id, options.organizationId);
      if (row.status !== 'ready') throw new MediaError('not_found', `${row.name} is still uploading`);
      const scope = row.organizationId ? { organizationId: row.organizationId } : {};
      const { media_link_seconds: fallback, media_link_max_seconds: max } = await this.settings.resolveMany(['media_link_seconds', 'media_link_max_seconds'], scope);
      const seconds = options.seconds ?? Number(fallback);
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > Number(max)) throw new MediaError('invalid_args', `a link may last 60 to ${Number(max)} seconds`);
      const cacheKey = `${row.id}\n${seconds}\n${row.updatedAt.getTime()}`;
      const cached = this.#links.get(cacheKey);
      if (cached && cached.expiresAt - Date.now() >= (seconds * 1000) / 2) {
        out.push({ id: row.id, url: cached.url, expiresAt: new Date(cached.expiresAt).toISOString() });
        continue;
      }
      const client = await this.#client(await this.#storageOf(row));
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: row.bucket, Key: row.key,
        ResponseContentType: row.mimeType, ResponseContentDisposition: disposition(row) }), { expiresIn: seconds });
      const expiresAt = Date.now() + seconds * 1000;
      if (this.#links.size >= 10_000) this.#links.clear();
      this.#links.set(cacheKey, { url, expiresAt });
      out.push({ id: row.id, url, expiresAt: new Date(expiresAt).toISOString() });
    }
    return out;
  }

  /** A ready file onto this server's disk, into `dir`, named
   *  `<id>_<name>`. Answers the path. */
  async download(id: string, dir: string, organizationId?: string | null): Promise<string> {
    const row = await this.get(id, organizationId);
    if (row.status !== 'ready') throw new MediaError('not_found', `${row.name} is still uploading`);
    const client = await this.#client(await this.#storageOf(row));
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${row.id}_${row.name.replace(/[^\w.-]+/g, '_')}`);
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: row.bucket, Key: row.key }));
      if (!(object.Body instanceof Readable)) throw new Error('the provider sent no body');
      await pipeline(object.Body, fs.createWriteStream(target));
    } catch (error) {
      await fs.promises.rm(target, { force: true });
      throw new MediaError('storage_failed', `could not download ${row.name}: ${providerWords(error)}`);
    }
    return target;
  }

  /** Remove a file: its bytes, then its row. An unfinished upload is aborted. */
  async delete(id: string, organizationId?: string | null): Promise<void> {
    const row = await this.get(id, organizationId);
    const storage = await this.#storageOf(row);
    const client = await this.#client(storage);
    try {
      if (row.uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: row.bucket, Key: row.key, UploadId: row.uploadId })).catch(() => {});
      await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.key }));
    } catch (error) {
      throw new MediaError('storage_failed', `could not delete ${row.name}: ${providerWords(error)}`);
    }
    await this.database.delete(media).where(eq(media.id, row.id));
  }

  /** Uploads never completed (a browser closed mid-way): gone after a day,
   *  bytes and parts with them. Driven from the maintenance loop. */
  async sweep(): Promise<void> {
    const stale = await this.database.select().from(media)
      .where(and(eq(media.status, 'uploading'), lt(media.createdAt, new Date(Date.now() - ABANDONED_MS)))).limit(100);
    for (const row of stale) {
      const storage = await this.#storageOf(row).catch(() => null);
      if (storage) await this.#discard(row, storage);
      else await this.database.delete(media).where(eq(media.id, row.id));
      log.info({ media: row.id }, 'abandoned upload swept');
    }
  }

  // ── setup ────────────────────────────────────────────────────────────

  /** Let browsers on `origins` upload to and read from the bucket directly
   *  (the bucket's CORS rule). Some providers take this only in their own
   *  dashboard: then `cors` says so, and the rule to enter there. */
  async setup(origins: string[], organizationId: string | null = null): Promise<{ cors: 'set' | 'unsupported'; message?: string; rule: object }> {
    const storage = await this.#storageFor(organizationId);
    const rule = { AllowedOrigins: origins, AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 };
    if (!origins.length) throw new MediaError('invalid_args', 'origins: the web app addresses that upload and view files (https://app.example)');
    try {
      const client = await this.#client(storage);
      await client.send(new PutBucketCorsCommand({ Bucket: storage.bucket, CORSConfiguration: { CORSRules: [rule] } }));
      return { cors: 'set', rule };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      return { cors: 'unsupported', message: `can't set up CORS via API (${providerWords(error)}) — add this rule in the provider's dashboard`, rule };
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────

/** The provider's own words for a failure. */
function providerWords(error: unknown): string {
  const failure = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = failure.$metadata?.httpStatusCode;
  return [failure.name && failure.name !== 'Error' ? failure.name : '', failure.message ?? errStr(error), status ? `(HTTP ${status})` : ''].filter(Boolean).join(' ');
}

const tooLarge = (size: number, max: number) => new MediaError('too_large', `${size} bytes is over the ${max}-byte limit`);
const notAllowed = (type: string, allowed: string[]) => new MediaError('type_not_allowed', `${type} files are not allowed (allowed: ${allowed.join(', ') || 'none'})`);

/** UTF-8 with no NUL — text, as far as a first sample can tell (the sample
 *  may end mid-character: that last partial one is let through). */
function isText(sample: Uint8Array): boolean {
  if (sample.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 3))); return true; } catch { return false; }
}

/** `image/png` against `image/*`, `application/pdf`. */
export function typeAllowed(type: string, allowed: string[]): boolean {
  const lower = type.toLowerCase();
  return allowed.some((pattern) => pattern === lower || (pattern.endsWith('/*') && lower.startsWith(pattern.slice(0, -1))));
}

/** Shown in place for media a browser plays safely, downloaded otherwise;
 *  the name as the person gave it (RFC 6266: an ASCII fallback, then UTF-8). */
function disposition(row: MediaRow): string {
  const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${INLINE.test(row.mimeType) ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`;
}
