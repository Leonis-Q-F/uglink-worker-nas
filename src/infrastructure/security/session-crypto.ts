const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return bytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  return base64ToBytes(`${normalized}${padding}`);
}

export function randomToken(size = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function aesKey(encodedKey: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64Url(encodedKey);
  } catch {
    throw new Error('SESSION_ENCRYPTION_KEY must be valid base64url.');
  }
  if (raw.byteLength !== 32) {
    throw new Error('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealJson(value: unknown, encodedKey: string, associatedData: string): Promise<string> {
  const key = await aesKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode(associatedData),
    tagLength: 128
  }, key, plaintext);
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openJson<T>(sealed: string, encodedKey: string, associatedData: string): Promise<T> {
  const [version, encodedIv, encodedCiphertext, extra] = sealed.split('.');
  if (version !== 'v1' || !encodedIv || !encodedCiphertext || extra) {
    throw new Error('Invalid encrypted payload.');
  }

  const key = await aesKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: fromBase64Url(encodedIv),
    additionalData: encoder.encode(associatedData),
    tagLength: 128
  }, key, fromBase64Url(encodedCiphertext));

  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
