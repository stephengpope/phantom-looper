// Media check — run by hand against a backend with media configured; not a
// suite. Every flow once: upload through the backend, browser-direct single
// PUT and multipart, the size and type limits, links (batch, bytes, range,
// reuse), the redirect, CORS setup, an organization's own storage, delete.
//
// Local storage: SeaweedFS (one container, real S3 signatures).
//   echo '{"identities":[{"name":"admin","credentials":[{"accessKey":"testkey","secretKey":"testsecret0123456789"}],"actions":["Admin","Read","Write","List"]}]}' > /tmp/s3.json
//   docker run -d --name media-s3 -p 127.0.0.1:58333:8333 -v /tmp/s3.json:/etc/s3.json chrislusf/seaweedfs server -s3 -s3.config=/etc/s3.json
//   create the bucket (any S3 tool), then PATCH /api/settings: media_endpoint http://127.0.0.1:58333,
//   media_region us-east-1, media_bucket, media_access_key_id testkey, media_secret_access_key testsecret0123456789
//
//   npm run build -w @phantom-agent-sdk/client
//   node phantom-agent-sdk/scripts/media-check.mjs <api-url> <api-key> [organization id whose own storage is a bucket named media-org]
import { BackendClient } from '../packages/client/dist/index.js';
import zlib from 'node:zlib';

const [url, key, org] = process.argv.slice(2);
const backend = new BackendClient({ url, credential: { phantomAdminKey: key }, clientId: 'media-check' });
const results = [];
const check = async (name, run) => {
  try { const note = await run(); results.push(`PASS ${name}${note ? ` — ${note}` : ''}`); }
  catch (error) { results.push(`FAIL ${name} — ${error.code ?? ''} ${error.message}`); }
};
const expectRefusal = async (code, run) => {
  try { await run(); } catch (error) { if (error.code === code || String(error.message).includes(code)) return error.message; throw error; }
  throw new Error(`expected ${code}, it went through`);
};

// A real 1×1 PNG.
const crc = (buf) => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  let r = 0xffffffff; for (const b of buf) r = crcTable[(r ^ b) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
// An MP4 start (ftyp box) padded to a size.
const mp4 = (size) => { const b = Buffer.alloc(size, 7); Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]).copy(b); return b; };

const ids = {};
await check('upload through the backend (png)', async () => {
  const file = await backend.media.upload(png, { name: 'dot ü.png', type: 'application/octet-stream' });
  if (file.status !== 'ready' || file.mimeType !== 'image/png' || file.size !== png.length) throw new Error(JSON.stringify(file));
  ids.png = file.id; return `${file.mimeType}, ${file.size} bytes, key ${file.key}`;
});
await check('text file refused by type', async () => expectRefusal('media_type_not_allowed', () => backend.media.upload(Buffer.from('hello'), { name: 'a.txt', type: 'text/plain' })));
await check('browser direct, single PUT (mp4, 2 MB)', async () => {
  const file = await backend.media.uploadDirect(new Blob([mp4(2 * 1024 ** 2)]), { name: 'clip.mp4', type: 'video/mp4' });
  if (file.status !== 'ready' || file.mimeType !== 'video/mp4') throw new Error(JSON.stringify(file));
  ids.small = file.id; return file.mimeType;
});
await check('browser direct, multipart (mp4, 110 MB)', async () => {
  const started = Date.now();
  const file = await backend.media.uploadDirect(new Blob([mp4(110 * 1024 ** 2)]), { name: 'big.mp4', type: 'video/mp4' });
  if (file.status !== 'ready' || file.size !== 110 * 1024 ** 2) throw new Error(JSON.stringify(file));
  ids.big = file.id; return `${file.size} bytes in ${Date.now() - started} ms`;
});
await check('more bytes than declared refused by storage', async () => {
  const { media, upload } = await backend.media.startUpload({ name: 'liar.mp4', size: 1000, type: 'video/mp4' });
  const response = await fetch(upload.url, { method: 'PUT', body: mp4(5000), headers: upload.headers });
  await backend.media.delete(media.id);
  if (response.ok) throw new Error(`storage took 5000 bytes on a 1000-byte URL (HTTP ${response.status})`);
  return `HTTP ${response.status}`;
});
await check('links: a batch, bytes match, range works, link reused', async () => {
  const links = await backend.media.links([ids.png, ids.small, ids.big]);
  if (links.length !== 3) throw new Error('not three links');
  const body = Buffer.from(await (await fetch(links[0].url)).arrayBuffer());
  if (!body.equals(png)) throw new Error('png bytes differ');
  const ranged = await fetch(links[2].url, { headers: { range: 'bytes=0-99' } });
  if (ranged.status !== 206 || (await ranged.arrayBuffer()).byteLength !== 100) throw new Error(`range answered ${ranged.status}`);
  const again = await backend.media.links([ids.png]);
  if (again[0].url !== links[0].url) throw new Error('a second ask made a new link');
  const disposition = (await fetch(links[0].url)).headers.get('content-disposition');
  return `206 on range; disposition: ${disposition}`;
});
await check('link longer than the cap refused', async () => expectRefusal('media_invalid_args', () => backend.media.links([ids.png], 999_999)));
await check('GET /media/:id/content redirects to storage', async () => {
  const response = await fetch(`${url}/media/${ids.png}/content`, { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' });
  if (response.status !== 302 || !response.headers.get('location')?.includes('media-main')) throw new Error(`HTTP ${response.status}`);
  return 'HTTP 302';
});
await check('size limit', async () => {
  await backend.call('PATCH', '/settings', { media_max_bytes: 50 });
  try {
    await expectRefusal('media_too_large', () => backend.media.upload(png, { name: 'dot.png' }));
    return await expectRefusal('media_too_large', () => backend.media.startUpload({ name: 'x.mp4', size: 51, type: 'video/mp4' }));
  } finally { await backend.call('PATCH', '/settings', { media_max_bytes: null }); }
});
await check('list', async () => { const files = await backend.media.list(); return `${files.length} files`; });
await check('CORS setup', async () => JSON.stringify(await backend.media.setup(['https://app.example'])));
if (org) {
  await check('organization with its own storage', async () => {
    const file = await backend.media.upload(png, { name: 'org.png', organization: org });
    if (file.bucket !== 'media-org' || !file.key.startsWith(`org/${org}/`)) throw new Error(JSON.stringify(file));
    const [link] = await backend.media.links([file.id]);
    if (!(await fetch(link.url)).ok) throw new Error('org link failed');
    ids.org = file.id; return `bucket ${file.bucket}, key ${file.key}`;
  });
}
await check('delete', async () => {
  const [link] = await backend.media.links([ids.small]);
  await backend.media.delete(ids.small);
  const after = await fetch(link.url);
  await expectRefusal('media_not_found', () => backend.media.get(ids.small));
  if (after.ok) throw new Error('the bytes are still served');
  return `storage answers ${after.status} after delete`;
});
console.log(results.join('\n'));
console.log(JSON.stringify(ids));
