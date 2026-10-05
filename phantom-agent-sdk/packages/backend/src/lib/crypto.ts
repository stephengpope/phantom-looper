// Credential encryption at rest. AES-256-GCM; the key comes from env and never
// touches the database. Layout: [iv 12][tag 16][ciphertext] in one bytea.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A Postgres role's password, derived from the encryption key and the
 *  role's label — stored nowhere, re-set on every boot (so a rotated key
 *  heals itself), never leaves this process. The backend's own roles and
 *  every agent play-space role get theirs this way. */
export function derivedPassword(key: Buffer, label: string): string {
  return createHmac('sha256', key).update(label).digest('base64url');
}

/** Secret comparison that takes the same time whether or not the strings
 *  match — the API bearer and the Telegram webhook secret both check with
 *  this. A plain `===` returns on the first differing byte. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufferA = Buffer.from(a); const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function encrypt(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
