import { hashPassword, verifyLegacyPassword, verifyPassword, isLegacyPasswordHash, isPasswordHash } from './utils';

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

/** True only for the current salted PBKDF2 storage format. */
export const isCurrentPasswordHash = (value: string): boolean => isPasswordHash(value);

/**
 * Verify passwords using Web Crypto where available. If the browser's
 * WebCrypto implementation rejects or mismatches the derivation, fall back to
 * the project's deterministic pure-JS verifier. This is important for private
 * browsing / embedded preview environments where crypto.subtle can behave
 * differently even though the stored PBKDF2 format is valid.
 */
export const verifyPasswordAsync = async (plain: string, storedHash: string): Promise<boolean> => {
  if (isLegacyPasswordHash(storedHash)) return verifyLegacyPassword(plain, storedHash);
  if (!isCurrentPasswordHash(storedHash)) return false;

  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const [saltText, hashText] = storedHash.split(':');
      const salt = base64ToBytes(saltText);
      const expected = base64ToBytes(hashText);
      if (salt.length === PBKDF2_SALT_BYTES && expected.length === PBKDF2_KEY_BYTES) {
        const key = await crypto.subtle.importKey(
          'raw',
          toArrayBuffer(new TextEncoder().encode(plain)),
          { name: 'PBKDF2' },
          false,
          ['deriveBits'],
        );
        const bits = await crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
          key,
          PBKDF2_KEY_BYTES * 8,
        );
        if (constantTimeEqual(expected, new Uint8Array(bits))) return true;
      }
    }
  } catch {
    // Fall through to the deterministic verifier below.
  }

  // Deterministic fallback uses the exact same PBKDF2 parameters and stored
  // format, so it does not weaken authentication or add a bypass.
  return verifyPassword(plain, storedHash);
};

/** Create a fresh random-salt PBKDF2-SHA-256 password hash. */
export const hashPasswordAsync = async (plain: string): Promise<string> => {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return hashPassword(plain);
    const salt = new Uint8Array(PBKDF2_SALT_BYTES);
    crypto.getRandomValues(salt);
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(new TextEncoder().encode(plain)),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      key,
      PBKDF2_KEY_BYTES * 8,
    );
    return `${bytesToBase64(salt)}:${bytesToBase64(new Uint8Array(bits))}`;
  } catch {
    return hashPassword(plain);
  }
};
