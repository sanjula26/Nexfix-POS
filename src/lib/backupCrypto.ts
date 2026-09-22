/**
 * Browser-only encryption for Google Drive backups.
 *
 * v1 backups remain passphrase-compatible for backward compatibility.
 * New backups use an automatically generated 256-bit recovery key. The key is
 * kept locally for automatic operation and can be recovered from the shop's
 * protected Drive recovery file when a PC is replaced.
 */
const PBKDF2_ITERATIONS = 310000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_KEY_STORAGE = 'nexfix_backup_recovery_key_v1';

export interface EncryptedBackupEnvelopeV1 {
  v: 1;
  alg: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  compressed: boolean;
  exportedAt: string;
  kind: 'auto' | 'manual';
  shopId: string;
}

export interface EncryptedBackupEnvelopeV2 {
  v: 2;
  alg: 'AES-256-GCM';
  keyMode: 'random-recovery-key';
  iv: string;
  ciphertext: string;
  compressed: boolean;
  exportedAt: string;
  kind: 'auto' | 'manual';
  shopId: string;
}

export type EncryptedBackupEnvelope = EncryptedBackupEnvelopeV1 | EncryptedBackupEnvelopeV2;

let sessionPassphrase: string | null = null;

function assertCrypto(): void {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error('This browser does not support secure Web Crypto backups.');
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(padded);
}

async function compress(data: Uint8Array): Promise<{ data: Uint8Array; compressed: boolean }> {
  if (typeof CompressionStream === 'undefined') return { data, compressed: false };
  const stream = new Blob([asArrayBuffer(data)]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return { data: new Uint8Array(buffer), compressed: true };
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress the encrypted backup.');
  const stream = new Blob([asArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  assertCrypto();
  const material = await crypto.subtle.importKey('raw', asArrayBuffer(new TextEncoder().encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asArrayBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function importRecoveryKey(value: string): Promise<CryptoKey> {
  assertCrypto();
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new Error('Recovery Key is invalid.');
  return crypto.subtle.importKey('raw', asArrayBuffer(bytes), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function setBackupPassphrase(passphrase: string): { ok: boolean; error?: string } {
  const value = passphrase;
  if (value.length < 12) return { ok: false, error: 'Backup passphrase must be at least 12 characters.' };
  sessionPassphrase = value;
  return { ok: true };
}

export function clearBackupPassphrase(): void { sessionPassphrase = null; }
export function hasBackupPassphrase(): boolean { return !!sessionPassphrase; }

export function getRecoveryKey(): string {
  try { return (localStorage.getItem(RECOVERY_KEY_STORAGE) || '').trim(); } catch { return ''; }
}

export function setRecoveryKey(value: string): { ok: boolean; error?: string } {
  const key = value.trim();
  try {
    if (base64UrlToBytes(key).length !== RECOVERY_KEY_BYTES) return { ok: false, error: 'Recovery Key is invalid.' };
    localStorage.setItem(RECOVERY_KEY_STORAGE, key);
    return { ok: true };
  } catch { return { ok: false, error: 'Could not save the Recovery Key on this browser.' }; }
}

export function hasRecoveryKey(): boolean { return !!getRecoveryKey(); }

export function ensureRecoveryKey(): string {
  const existing = getRecoveryKey();
  if (existing) return existing;
  assertCrypto();
  const key = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES)));
  const result = setRecoveryKey(key);
  if (!result.ok) throw new Error(result.error || 'Could not create the Recovery Key.');
  return key;
}

export async function sha256Hex(value: string): Promise<string> {
  assertCrypto();
  const digest = await crypto.subtle.digest('SHA-256', asArrayBuffer(new TextEncoder().encode(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getBackupSecurityMessage(): string {
  return 'Google Drive backups use automatic AES-256-GCM encryption. A unique Recovery Key is generated automatically for this shop. Keep a copy of the Recovery Key safe: anyone who has both the encrypted backup and the Recovery Key can decrypt the backup.';
}

export async function encryptBackupState(
  state: unknown,
  shopId: string,
  kind: 'auto' | 'manual',
  exportedAt: string,
): Promise<EncryptedBackupEnvelopeV2> {
  assertCrypto();
  const recoveryKey = ensureRecoveryKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const packed = await compress(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importRecoveryKey(recoveryKey);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asArrayBuffer(iv) }, key, asArrayBuffer(packed.data));
  return {
    v: 2,
    alg: 'AES-256-GCM',
    keyMode: 'random-recovery-key',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    compressed: packed.compressed,
    exportedAt,
    kind,
    shopId,
  };
}

export function isEncryptedBackupEnvelope(input: unknown): input is EncryptedBackupEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (value.v === 1) {
    return value.alg === 'AES-256-GCM'
      && value.kdf === 'PBKDF2-SHA-256'
      && Number(value.iterations) >= PBKDF2_ITERATIONS
      && typeof value.salt === 'string' && typeof value.iv === 'string'
      && typeof value.ciphertext === 'string' && typeof value.shopId === 'string';
  }
  return value.v === 2
    && value.alg === 'AES-256-GCM'
    && value.keyMode === 'random-recovery-key'
    && typeof value.iv === 'string'
    && typeof value.ciphertext === 'string'
    && typeof value.shopId === 'string';
}

async function decryptV1(envelope: EncryptedBackupEnvelopeV1): Promise<unknown> {
  if (!sessionPassphrase) throw new Error('This is an older encrypted backup. Enter the original Backup Passphrase to restore it.');
  if (envelope.iterations < PBKDF2_ITERATIONS) throw new Error('Encrypted backup uses an unsupported key-derivation strength.');
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  if (salt.length < SALT_BYTES || iv.length !== IV_BYTES) throw new Error('Encrypted backup metadata is invalid.');
  const key = await deriveKey(sessionPassphrase, salt, envelope.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asArrayBuffer(iv) }, key, asArrayBuffer(base64ToBytes(envelope.ciphertext)));
  const data = envelope.compressed ? await decompress(new Uint8Array(plaintext)) : new Uint8Array(plaintext);
  return JSON.parse(new TextDecoder().decode(data));
}

export async function decryptBackupEnvelope(envelope: EncryptedBackupEnvelope): Promise<unknown> {
  assertCrypto();
  try {
    let plaintext: ArrayBuffer;
    if (envelope.v === 2) {
      const recoveryKey = getRecoveryKey();
      if (!recoveryKey) throw new Error('Recovery Key is required for this automatic encrypted backup.');
      const iv = base64ToBytes(envelope.iv);
      if (iv.length !== IV_BYTES) throw new Error('Encrypted backup metadata is invalid.');
      const key = await importRecoveryKey(recoveryKey);
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asArrayBuffer(iv) }, key, asArrayBuffer(base64ToBytes(envelope.ciphertext)));
    } else {
      return await decryptV1(envelope);
    }
    const data = envelope.compressed ? await decompress(new Uint8Array(plaintext)) : new Uint8Array(plaintext);
    return JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    if (error instanceof Error && error.message === 'This is an older encrypted backup. Enter the original Backup Passphrase to restore it.') throw error;
    if (error instanceof Error && error.message === 'Recovery Key is required for this automatic encrypted backup.') throw error;
    throw new Error('Recovery Key is wrong or the encrypted backup is corrupted. Restore was not performed.');
  }
}
