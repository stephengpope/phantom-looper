// Media — the backend's tracked files on S3-compatible storage, over its
// /media routes (the service role's; an app's own users reach files through
// the app's /app routes). Two ways to send a file:
//   - upload(bytes)  — through the backend, streamed: a server, a script, a cli
//   - uploadDirect(file) — a browser sending straight to storage on presigned
//     URLs (one PUT, or parts for a large file), then completing. The bucket
//     needs a CORS rule for the page's origin (setup).
// Files come back as short-lived links: links(ids) for a page's worth at once.
import type { BackendClient } from './backend.js';

/** One tracked file, as the backend answers it. */
export interface MediaFile {
  id: string;
  organizationId: string | null;
  userId: string | null;
  projectId: string | null;
  sessionId: string | null;
  name: string;
  mimeType: string;
  size: number;
  status: 'uploading' | 'ready';
  endpoint: string;
  bucket: string;
  key: string;
  uploadId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Who a file belongs to; nothing = the service role's. */
export type MediaOwner = { organization?: string; project?: string; user?: string };

export type MediaUploadPlan =
  | { mode: 'single'; url: string; headers: Record<string, string> }
  | { mode: 'multipart'; partSize: number; parts: { partNumber: number; url: string }[] };

export interface MediaLink { id: string; url: string; expiresAt: string }

/** Parts in flight at once for a direct upload. */
const PART_CONCURRENCY = 4;

const query = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  return entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}` : '';
};

export class Media {
  constructor(private readonly backend: BackendClient) {}

  /** Ready files, newest first. */
  async list(filter: MediaOwner & { limit?: number } = {}): Promise<MediaFile[]> {
    return (await this.backend.call<{ media: MediaFile[] }>('GET', `/media${query(filter)}`)).media;
  }

  get(id: string): Promise<MediaFile> {
    return this.backend.call<MediaFile>('GET', `/media/${encodeURIComponent(id)}`);
  }

  /** Send a file through the backend; answers it ready. `type`: what the
   *  sender believes it is — the backend reads the real type from the bytes. */
  upload(bytes: Blob | Uint8Array | ReadableStream<Uint8Array>, options: MediaOwner & { name: string; type?: string }): Promise<MediaFile> {
    return this.backend.callBytes<MediaFile>('POST', `/media${query(options)}`, bytes as BodyInit, 'application/octet-stream');
  }

  /** Start a direct upload: the file's record and the URLs to PUT to. */
  startUpload(options: MediaOwner & { name: string; size: number; type: string }): Promise<{ media: MediaFile; upload: MediaUploadPlan }> {
    return this.backend.call('POST', '/media/uploads', options);
  }

  /** After the PUTs: a multipart upload sends each part's ETag. */
  complete(id: string, parts?: { partNumber: number; etag: string }[]): Promise<MediaFile> {
    return this.backend.call<MediaFile>('POST', `/media/${encodeURIComponent(id)}/complete`, parts ? { parts } : {});
  }

  /** The whole direct flow for a browser File/Blob: start, PUT the bytes
   *  straight to storage, complete. A failure deletes the half-made file. */
  async uploadDirect(file: Blob, options: MediaOwner & { name: string; type?: string; signal?: AbortSignal }): Promise<MediaFile> {
    const { signal, ...owner } = options;
    const started = await this.startUpload({ ...owner, size: file.size, type: options.type || file.type || 'application/octet-stream' });
    try {
      if (started.upload.mode === 'single') {
        await put(started.upload.url, file, started.upload.headers, signal);
        return await this.complete(started.media.id);
      }
      const { partSize, parts } = started.upload;
      const etags: { partNumber: number; etag: string }[] = [];
      let next = 0;
      const worker = async () => {
        for (let part = parts[next++]; part; part = parts[next++]) {
          const start = (part.partNumber - 1) * partSize;
          const etag = await put(part.url, file.slice(start, start + partSize), {}, signal);
          etags.push({ partNumber: part.partNumber, etag });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, worker));
      return await this.complete(started.media.id, etags);
    } catch (error) {
      await this.delete(started.media.id).catch(() => {});
      throw error;
    }
  }

  /** Short-lived links, one per id, in order. */
  async links(ids: string[], seconds?: number): Promise<MediaLink[]> {
    return (await this.backend.call<{ links: MediaLink[] }>('POST', '/media/links', { ids, ...(seconds ? { seconds } : {}) })).links;
  }

  async delete(id: string): Promise<void> {
    await this.backend.call('DELETE', `/media/${encodeURIComponent(id)}`);
  }

  /** Let web apps on `origins` upload to and play from the bucket directly. */
  setup(origins: string[], organization?: string): Promise<{ cors: 'set' | 'unsupported'; message?: string; rule: object }> {
    return this.backend.call('POST', '/media/setup', { origins, ...(organization ? { organization } : {}) });
  }
}

/** One PUT to storage; answers its ETag. The bucket's CORS rule must expose ETag. */
async function put(url: string, body: Blob, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { method: 'PUT', body, headers, signal });
  if (!response.ok) throw new Error(`storage refused the upload: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.headers.get('etag') ?? '';
}
