// AES-256-GCM on the relay. The key never enters the ciphertext.
// Layout: version (1) | iv (12) | tag (16) | ciphertext.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + IV_BYTES + TAG_BYTES;

export function createStorageKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function seal(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.alloc(HEADER + encrypted.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(tag, 1 + IV_BYTES);
  out.set(encrypted, HEADER);
  return new Uint8Array(out);
}

export function open(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  assertKey(key);
  if (sealed.byteLength < HEADER || sealed[0] !== VERSION) {
    throw new Error("bad_seal");
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, HEADER);
  const ciphertext = sealed.subarray(HEADER);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== 32) throw new Error("bad_key");
}
