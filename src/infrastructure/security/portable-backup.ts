import type {
  BackupCipher,
  PortableBackupPayload
} from '../../application/console/ports';
import type { EncryptedControlBackup } from '../../application/console/contracts';
import { fromBase64Url, toBase64Url } from './session-crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ITERATIONS = 210_000;
const ASSOCIATED_DATA = encoder.encode('uglink-control-backup:v1');

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: ITERATIONS
  }, material, { name: 'AES-GCM', length: 256 }, false, usages);
}

function assertBackupEnvelope(value: EncryptedControlBackup): void {
  if (
    value?.format !== 'uglink-control-backup'
    || value.version !== 1
    || value.kdf?.name !== 'PBKDF2'
    || value.kdf.hash !== 'SHA-256'
    || value.kdf.iterations !== ITERATIONS
    || typeof value.kdf.salt !== 'string'
    || value.cipher?.name !== 'AES-GCM'
    || typeof value.cipher.iv !== 'string'
    || typeof value.cipher.data !== 'string'
  ) {
    throw new Error('Invalid UGLINK backup envelope.');
  }
}

export const portableBackupCipher: BackupCipher = {
  async seal(payload, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: ASSOCIATED_DATA,
      tagLength: 128
    }, key, encoder.encode(JSON.stringify(payload)));
    return {
      format: 'uglink-control-backup',
      version: 1,
      createdAt: payload.createdAt,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: ITERATIONS,
        salt: toBase64Url(salt)
      },
      cipher: {
        name: 'AES-GCM',
        iv: toBase64Url(iv),
        data: toBase64Url(new Uint8Array(encrypted))
      }
    };
  },
  async open(backup, passphrase) {
    assertBackupEnvelope(backup);
    const salt = fromBase64Url(backup.kdf.salt);
    const iv = fromBase64Url(backup.cipher.iv);
    if (salt.byteLength !== 16 || iv.byteLength !== 12) {
      throw new Error('Invalid UGLINK backup parameters.');
    }
    const key = await deriveKey(passphrase, salt, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: ASSOCIATED_DATA,
      tagLength: 128
    }, key, fromBase64Url(backup.cipher.data));
    return JSON.parse(decoder.decode(plaintext)) as PortableBackupPayload;
  }
};
