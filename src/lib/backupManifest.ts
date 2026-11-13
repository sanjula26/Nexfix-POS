export interface GoogleBackupManifest {
  backupId: string;
  totalBytes: number;
  totalParts: number;
  partNames: string[];
  sha256: string;
  exportedAt: string;
}

export const MAX_GOOGLE_BACKUP_BYTES = 1024 * 1024 * 1024;
export const MAX_GOOGLE_BACKUP_PARTS = 256;

/**
 * Validate untrusted Drive manifest metadata before making any per-part requests.
 * Part names must match the sequential naming convention used by the uploader.
 */
export function isValidGoogleBackupManifest(value: unknown): value is GoogleBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.backupId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(manifest.backupId)) return false;
  if (!Number.isSafeInteger(manifest.totalBytes) || (manifest.totalBytes as number) < 1
    || (manifest.totalBytes as number) > MAX_GOOGLE_BACKUP_BYTES) return false;
  if (!Number.isSafeInteger(manifest.totalParts) || (manifest.totalParts as number) < 1
    || (manifest.totalParts as number) > MAX_GOOGLE_BACKUP_PARTS
    || (manifest.totalParts as number) > (manifest.totalBytes as number)) return false;
  if (!Array.isArray(manifest.partNames) || manifest.partNames.length !== manifest.totalParts) return false;
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) return false;
  if (typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt))) return false;

  const names = manifest.partNames;
  const first = typeof names[0] === 'string' ? names[0].match(/^(NEXFIX_[a-f0-9]{24}_\d{4}-\d{2}-\d{2})\.part(\d{3,})$/i) : null;
  if (!first || Number(first[2]) !== 1) return false;
  const prefix = first[1];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof name !== 'string' || name.length > 180) return false;
    const match = name.match(/^(NEXFIX_[a-f0-9]{24}_\d{4}-\d{2}-\d{2})\.part(\d{3,})$/i);
    if (!match || match[1] !== prefix || Number(match[2]) !== index + 1) return false;
  }
  return true;
}
