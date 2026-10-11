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
// Two ways in, one way to a row:
//   - upload(stream)            — through this server, streamed (lib-storage)
//   - createUpload() + complete() — straight from the browser: one presigned
//                                 PUT, or a presigned multipart upload for a
//                                 large file, then the browser says it is done
// Every one ends in #record: the object's real size from the provider, its
// type from its first bytes (file-type), both checked against the limits —
// and only THEN the row, ready. A file that fails is deleted. An upload the
// browser never finished leaves no row at all: its bytes are the bucket's
// to expire. Nothing trusts what the uploader claimed.
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
import { and, desc, eq, type SQL } from 'drizzle-orm';
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
    | 'storage_changed' | 'storage_failed', message: string) { super(message); this.name = 'MediaError'; }
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
  | { mode: 'multipart'; uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] };

export interface MediaLink { id: string; url: string; expiresAt: string }

/** Up to this size a browser sends one PUT; above it, parts. */
const SINGLE_PUT_MAX = 100 * 1024 ** 2;
/** Part size: 16 MiB, or bigger when a file would need more than the 10,000 parts S3 allows. */
const PART_SIZE = 16 * 1024 ** 2;
const MAX_PARTS = 10_000;
/** How long a browser has to start sending once it has its upload URLs. */
const UPLOAD_URL_SECONDS = 3600;
/** What #record reads to tell the type — file-type's own sample size. */
const SNIFF_BYTES = 4100;
/** Types a browser may show in place; anything else downloads. */
const INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$)/;

interface Storage { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }
/** A file on its way in: where its bytes go, before any row exists. */
interface Incoming { id: string; key: string; name: string; organizationId: string; storage: Storage }
const isId = (id: string): boolean => /^[0-9a-z]{26}$/i.test(id);

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

  /** Files, newest first. Each filter given narrows; `organizationId` null = the service role's. */
  async list(filter: { organizationId?: string | null; projectId?: string; userId?: string; limit?: number } = {}): Promise<MediaRow[]> {
    const where: SQL[] = [];
    if (filter.organizationId !== undefined) where.push(eq(media.organizationId, filter.organizationId ?? SERVICE_ROLE_ORGANIZATION));
    if (filter.projectId) where.push(eq(media.projectId, filter.projectId));
    if (filter.userId) where.push(eq(media.userId, filter.userId));
    return this.database.select().from(media).where(where.length ? and(...where) : undefined).orderBy(desc(media.createdAt)).limit(Math.min(filter.limit ?? 100, 1000));
  }

  /** Files of an organization — what refuses its deletion. */
  async ofOrganization(organizationId: string): Promise<number> {
    return (await this.database.select({ id: media.id }).from(media).where(eq(media.organizationId, organizationId)).limit(1)).length;
  }

  // ── uploads ──────────────────────────────────────────────────────────

  /** Upload through this server: the stream goes to the bucket as it
   *  arrives (multipart, 16 MiB parts, four in flight — memory stays
   *  bounded), counted against the size limit; then checked and recorded.
   *  `signal` aborts it (the uploader hung up). */
  async upload(body: Readable, options: { name: string; owner: MediaOwner; mimeType?: string; size?: number; signal?: AbortSignal }): Promise<MediaRow> {
    const limits = await this.#limits(options.owner.organizationId);
    if (options.size !== undefined && options.size > limits.maxBytes) throw tooLarge(options.size, limits.maxBytes);
    const file = await this.#incoming(options.owner, newId(), options.name);
    const mimeType = options.mimeType ?? 'application/octet-stream';
    try {
      let counted = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          counted += chunk.length;
          done(counted > limits.maxBytes ? tooLarge(counted, limits.maxBytes) : null, chunk);
        },
      });
      const upload = new Upload({
        client: await this.#client(file.storage), partSize: PART_SIZE, queueSize: 4, leavePartsOnError: false,
        params: { Bucket: file.storage.bucket, Key: file.key, Body: body.pipe(counter), ContentType: mimeType },
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
      return await this.#record(file, options.owner, mimeType, null);
    } catch (error) {
      await this.#remove(file.storage, file.key);
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

  /** Start a browser upload: the file's id, and the presigned URLs the
   *  browser sends the bytes to. No row yet — the row is `complete`'s, once
   *  the bytes are in and checked. The size and type are checked now and
   *  again then; each URL is signed for its exact length, so the provider
   *  refuses more bytes than were declared. */
  async createUpload(options: { name: string; size: number; mimeType: string; owner: MediaOwner }): Promise<{ id: string; upload: UploadPlan }> {
    const limits = await this.#limits(options.owner.organizationId);
    if (!Number.isInteger(options.size) || options.size < 1) throw new MediaError('invalid_args', 'size must be the file\'s length in bytes');
    if (options.size > limits.maxBytes) throw tooLarge(options.size, limits.maxBytes);
    if (!typeAllowed(options.mimeType, limits.allowed)) throw notAllowed(options.mimeType, limits.allowed);
    const file = await this.#incoming(options.owner, newId(), options.name);
    try {
      const client = await this.#client(file.storage);
      if (options.size <= SINGLE_PUT_MAX) {
        const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: file.storage.bucket, Key: file.key, ContentType: options.mimeType, ContentLength: options.size }),
          { expiresIn: UPLOAD_URL_SECONDS, signableHeaders: new Set(['content-type']) });
        return { id: file.id, upload: { mode: 'single', url, headers: { 'content-type': options.mimeType } } };
      }
      const partSize = Math.max(PART_SIZE, Math.ceil(options.size / MAX_PARTS / 1024 ** 2) * 1024 ** 2);
      const count = Math.ceil(options.size / partSize);
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: file.storage.bucket, Key: file.key, ContentType: options.mimeType }));
      if (!created.UploadId) throw new Error('the provider gave no upload id');
      const parts = await Promise.all(Array.from({ length: count }, async (_unused, i) => ({
        partNumber: i + 1,
        url: await getSignedUrl(client, new UploadPartCommand({ Bucket: file.storage.bucket, Key: file.key, UploadId: created.UploadId, PartNumber: i + 1,
          ContentLength: i + 1 < count ? partSize : options.size - partSize * (count - 1) }), { expiresIn: UPLOAD_URL_SECONDS }),
      })));
      return { id: file.id, upload: { mode: 'multipart', uploadId: created.UploadId, partSize, parts } };
    } catch (error) {
      throw new MediaError('storage_failed', `could not start the upload of ${options.name}: ${providerWords(error)}`);
    }
  }

  /** The browser sent everything: finish a multipart upload (its parts'
   *  ETags, as each part's PUT answered them), check the object, and only
   *  then write the row. What the browser says about the file — its name,
   *  declared size and type — is what it said at the start; the size and
   *  type are read off the object itself. */
  async complete(id: string, options: { owner: MediaOwner; name: string; size: number; mimeType: string; uploadId?: string; parts?: { partNumber: number; etag: string }[] }): Promise<MediaRow> {
    if (!isId(id)) throw new MediaError('invalid_args', `${id} is not an upload id`);
    const limits = await this.#limits(options.owner.organizationId);
    if (!Number.isInteger(options.size) || options.size < 1) throw new MediaError('invalid_args', 'size must be the file\'s length in bytes');
    if (options.size > limits.maxBytes) throw tooLarge(options.size, limits.maxBytes);
    if (!typeAllowed(options.mimeType, limits.allowed)) throw notAllowed(options.mimeType, limits.allowed);
    const file = await this.#incoming(options.owner, id, options.name);
    if (options.uploadId) {
      if (!options.parts?.length) throw new MediaError('invalid_args', 'a multipart upload completes with its parts: [{ partNumber, etag }]');
      try {
        const client = await this.#client(file.storage);
        await client.send(new CompleteMultipartUploadCommand({ Bucket: file.storage.bucket, Key: file.key, UploadId: options.uploadId,
          MultipartUpload: { Parts: [...options.parts].sort((a, b) => a.partNumber - b.partNumber).map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }));
      } catch (error) {
        await this.#remove(file.storage, file.key, options.uploadId);
        throw new MediaError('storage_failed', `could not finish the upload of ${file.name}: ${providerWords(error)}`);
      }
    }
    try {
      return await this.#record(file, options.owner, options.mimeType, options.size);
    } catch (error) {
      await this.#remove(file.storage, file.key);
      throw error;
    }
  }

  /** The browser gave up mid-way: its bytes and parts go. No row ever existed. */
  async abandon(id: string, options: { owner: MediaOwner; uploadId?: string }): Promise<void> {
    if (!isId(id)) throw new MediaError('invalid_args', `${id} is not an upload id`);
    const file = await this.#incoming(options.owner, id, 'upload');
    await this.#remove(file.storage, file.key, options.uploadId);
  }

  /** The object as it really is — its size from the provider, its type
   *  from its first bytes — checked against the limits, then the row.
   *  `expectedSize`: what a browser upload declared, null through the server. */
  async #record(file: Incoming, owner: MediaOwner, claimedType: string, expectedSize: number | null): Promise<MediaRow> {
    const limits = await this.#limits(owner.organizationId);
    const client = await this.#client(file.storage);
    let size: number;
    let head: Uint8Array;
    try {
      size = Number((await client.send(new HeadObjectCommand({ Bucket: file.storage.bucket, Key: file.key }))).ContentLength ?? 0);
      const sample = await client.send(new GetObjectCommand({ Bucket: file.storage.bucket, Key: file.key, Range: `bytes=0-${SNIFF_BYTES - 1}` }));
      head = sample.Body ? await sample.Body.transformToByteArray() : new Uint8Array();
    } catch (error) {
      throw new MediaError('storage_failed', `could not check ${file.name}: ${providerWords(error)}`);
    }
    if (expectedSize !== null && size !== expectedSize) throw new MediaError('invalid_args', `${file.name} arrived as ${size} bytes, not the ${expectedSize} declared`);
    if (size > limits.maxBytes) throw tooLarge(size, limits.maxBytes);
    if (size === 0) throw new MediaError('invalid_args', `${file.name} is empty`);
    // Binary formats announce themselves in their first bytes. Text cannot:
    // a text/* claim stands only when the bytes are text; anything else
    // unrecognised is unknown binary.
    const detected = (await fileTypeFromBuffer(head))?.mime;
    const mimeType = detected ?? (claimedType.startsWith('text/') && isText(head) ? claimedType : 'application/octet-stream');
    if (!typeAllowed(mimeType, limits.allowed)) throw notAllowed(mimeType, limits.allowed);
    const [row] = await this.database.insert(media).values({
      id: file.id, organizationId: file.organizationId, userId: owner.userId ?? null, projectId: owner.projectId ?? null, sessionId: owner.sessionId ?? null,
      name: file.name, mimeType, size, endpoint: file.storage.endpoint, bucket: file.storage.bucket, key: file.key,
    }).returning();
    log.info({ media: row.id, size, mimeType }, 'media ready');
    return row;
  }

  /** Where a file's bytes go: the organization's storage, and a key in its
   *  namespace off the file's own id. The user's name for it goes in the
   *  row, never in the key. */
  async #incoming(owner: MediaOwner, id: string, name: string): Promise<Incoming> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 255) throw new MediaError('invalid_args', 'name must be 1–255 characters');
    const storage = await this.#storageFor(owner.organizationId);
    const organizationId = owner.organizationId ?? SERVICE_ROLE_ORGANIZATION;
    return { id, key: `org/${organizationId}/${id}`, name: trimmed, organizationId, storage };
  }

  /** The bytes of a file that will not become a row — and, for a multipart
   *  upload, its parts. Best effort at the provider: an object left behind
   *  is the bucket's to expire. */
  async #remove(storage: Storage, key: string, uploadId?: string): Promise<void> {
    try {
      const client = await this.#client(storage);
      if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: key, UploadId: uploadId })).catch(() => {});
      await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    } catch (error) {
      log.warn({ key, err: errStr(error) }, 'could not remove the bytes of a discarded media file');
    }
  }

  async #limits(organizationId: string | null): Promise<{ maxBytes: number; allowed: string[] }> {
    const scope = organizationId ? { organizationId } : {};
    const values = await this.settings.resolveMany(['media_max_bytes', 'media_allowed_types'], scope);
    return { maxBytes: Number(values.media_max_bytes), allowed: (typeof values.media_allowed_types === 'string' ? values.media_allowed_types : '').split(',').map((type) => type.trim().toLowerCase()).filter(Boolean) };
  }

  // ── out ──────────────────────────────────────────────────────────────

  /** Download links, in the order asked. `seconds`: how
   *  long they work (default media_link_seconds, at most
   *  media_link_max_seconds). Another organization's file is not found. */
  async links(ids: string[], options: { organizationId?: string | null; seconds?: number } = {}): Promise<MediaLink[]> {
    const out: MediaLink[] = [];
    for (const id of ids) {
      const row = await this.get(id, options.organizationId);
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

  /** A file onto this server's disk, into `dir`, named `<id>_<name>`.
   *  Answers the path. */
  async download(id: string, dir: string, organizationId?: string | null): Promise<string> {
    const row = await this.get(id, organizationId);
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

  /** Remove a file: its bytes, then its row. */
  async delete(id: string, organizationId?: string | null): Promise<void> {
    const row = await this.get(id, organizationId);
    const storage = await this.#storageOf(row);
    const client = await this.#client(storage);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.key }));
    } catch (error) {
      throw new MediaError('storage_failed', `could not delete ${row.name}: ${providerWords(error)}`);
    }
    await this.database.delete(media).where(eq(media.id, row.id));
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
