import { hashPassword, verifyLegacyPassword, verifyPassword, isLegacyPasswordHash, isPasswordHash } from './utils.ts';

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
export const verifyPasswordAsyncWithFallback = async (
  plain: string,
  storedHash: string,
  fallbackVerifier: (plain: string, storedHash: string) => boolean = verifyPassword,
): Promise<boolean> => {
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
        // A completed WebCrypto derivation that does not match is a normal
        // invalid-credential result. Do not repeat 600k iterations synchronously.
        return constantTimeEqual(expected, new Uint8Array(bits));
      }
    }
  } catch {
    // Fall through only when WebCrypto is unavailable or throws.
  }

  // Deterministic fallback uses the exact same PBKDF2 parameters and stored
  // format, so it does not weaken authentication or add a bypass.
  return fallbackVerifier(plain, storedHash);
};

export const verifyPasswordAsync = (plain: string, storedHash: string): Promise<boolean> =>
  verifyPasswordAsyncWithFallback(plain, storedHash);

/**
 * Verify a stored PIN/password and prepare a PBKDF2 replacement only after
 * a successful legacy-hash match. Callers persist upgradedHash after success.
 */
export const verifyPasswordWithLegacyUpgrade = async (
  plain: string,
  storedHash: string,
): Promise<{ valid: boolean; upgradedHash?: string }> => {
  const valid = await verifyPasswordAsync(plain, storedHash);
  if (!valid) return { valid: false };
  if (isLegacyPasswordHash(storedHash)) {
    return { valid: true, upgradedHash: await hashPasswordAsync(plain) };
  }
  return { valid: true };
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
