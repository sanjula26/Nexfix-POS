const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const FORMAT = 'pbkdf2-sha256';

function getCrypto(): Crypto {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error('WebCrypto is required for secure password hashing');
  }
  return crypto;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await getCrypto().subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await getCrypto().subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Create a password/PIN hash using PBKDF2-SHA-256 and a fresh random salt. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = getCrypto().getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(plain, salt);
  return `${FORMAT}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/** Verify a PBKDF2 credential. Invalid/corrupt records fail closed. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== FORMAT) return false;
    const iterations = Number(parts[1]);
    if (iterations !== PBKDF2_ITERATIONS) return false;
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false;
    const actual = await derive(plain, salt);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Identify the versioned PBKDF2 credential format. */
export function isPbkdf2Hash(value: string): boolean {
  return value.startsWith(`${FORMAT}$`);
}

export const PASSWORD_HASH_ITERATIONS = PBKDF2_ITERATIONS;
