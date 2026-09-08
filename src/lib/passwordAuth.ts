import { hashPassword as hashPbkdf2Password, isPbkdf2Hash, verifyPassword as verifyPbkdf2Password } from './password';
import { hashPassword as hashLegacyPassword, isHashed as isLegacyHash, verifyPassword as verifyLegacyPassword } from './utils';

export interface CredentialVerification {
  ok: boolean;
  needsRehash: boolean;
}

/**
 * Verify credentials during the PBKDF2 migration window.
 *
 * Supported formats:
 * - PBKDF2-SHA256 (preferred)
 * - legacy SHA-256 hash
 * - legacy plaintext (only for one-time migration)
 */
export async function verifyCredential(plain: string, stored: string): Promise<CredentialVerification> {
  if (isPbkdf2Hash(stored)) {
    return { ok: await verifyPbkdf2Password(plain, stored), needsRehash: false };
  }

  if (isLegacyHash(stored)) {
    return { ok: verifyLegacyPassword(plain, stored), needsRehash: true };
  }

  return { ok: stored === plain, needsRehash: true };
}

/** Hash a newly-created credential using the preferred PBKDF2 format. */
export async function hashCredential(plain: string): Promise<string> {
  return hashPbkdf2Password(plain);
}

/** Legacy SHA-256 hash, retained only for compatibility/migration checks. */
export function hashLegacyCredential(plain: string): string {
  return hashLegacyPassword(plain);
}
