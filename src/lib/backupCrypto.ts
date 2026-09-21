/**
 * Browser-only encryption for Google Drive backups.
 * The passphrase never leaves this browser and is never persisted.
 */
const PBKDF2_ITERATIONS = 310000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedBackupEnvelope {
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

let sessionPassphrase: string | null = null;

function assertCrypto(): void {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error('This browser does not support secure Web Crypto backups.');
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function compress(data: Uint8Array): Promise<{ data: Uint8Array; compressed: boolean }> {
  if (typeof CompressionStream === 'undefined') return { data, compressed: false };
  const stream = new Blob([asArrayBuffer(data)]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return { data: new Uint8Array(buffer), compressed: true };
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the encrypted backup.');
  }
  const stream = new Blob([asArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  assertCrypto();
  const material = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asArrayBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function setBackupPassphrase(passphrase: string): { ok: boolean; error?: string } {
  const value = passphrase;
  if (value.length < 12) return { ok: false, error: 'Backup passphrase must be at least 12 characters.' };
  sessionPassphrase = value;
  return { ok: true };
}

export function clearBackupPassphrase(): void {
  sessionPassphrase = null;
}

export function hasBackupPassphrase(): boolean {
  return !!sessionPassphrase;
}

export async function sha256Hex(value: string): Promise<string> {
  assertCrypto();
  const digest = await crypto.subtle.digest('SHA-256', asArrayBuffer(new TextEncoder().encode(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getBackupSecurityMessage(): string {
  return 'Google Drive backups are encrypted in this browser. The passphrase is never stored or sent to Google. If it is lost, the encrypted backup cannot be restored.';
}

export async function encryptBackupState(
  state: unknown,
  shopId: string,
  kind: 'auto' | 'manual',
  exportedAt: string,
): Promise<EncryptedBackupEnvelope> {
  assertCrypto();
  if (!sessionPassphrase) throw new Error('Set the Backup Passphrase in Settings before using encrypted Google Drive backup.');
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const packed = await compress(plaintext);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(sessionPassphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asArrayBuffer(iv) }, key, asArrayBuffer(packed.data));
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
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
  return value.v === 1
    && value.alg === 'AES-256-GCM'
    && value.kdf === 'PBKDF2-SHA-256'
    && Number(value.iterations) >= PBKDF2_ITERATIONS
    && typeof value.salt === 'string'
    && typeof value.iv === 'string'
    && typeof value.ciphertext === 'string'
    && typeof value.shopId === 'string';
}

export async function decryptBackupEnvelope(envelope: EncryptedBackupEnvelope): Promise<unknown> {
  assertCrypto();
  if (!sessionPassphrase) throw new Error('Enter the Backup Passphrase before restoring encrypted Google Drive data.');
  if (envelope.iterations < PBKDF2_ITERATIONS) throw new Error('Encrypted backup uses an unsupported key-derivation strength.');
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    if (salt.length < SALT_BYTES || iv.length !== IV_BYTES) throw new Error('Encrypted backup metadata is invalid.');
    const key = await deriveKey(sessionPassphrase, salt, envelope.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asArrayBuffer(iv) },
      key,
      asArrayBuffer(base64ToBytes(envelope.ciphertext)),
    );
    const data = envelope.compressed ? await decompress(new Uint8Array(plaintext)) : new Uint8Array(plaintext);
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error('Wrong Backup Passphrase or corrupted encrypted backup. Restore was not performed.');
  }
}
