// Credential encryption at rest. AES-256-GCM; the key comes from env and never
// touches the database. Layout: [iv 12][tag 16][ciphertext] in one bytea.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** Secret comparison that takes the same time whether or not the strings
 *  match — the API bearer and the Telegram webhook secret both check with
 *  this. A plain `===` returns on the first differing byte. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
