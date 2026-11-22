/**
 * Typed renderer bridge for the main-process-owned encrypted POS profile.
 *
 * This module deliberately does not activate a profile or choose a storage
 * backend. Callers must gate desktop startup before using it; browser/dev mode
 * continues to use the existing IndexedDB implementation.
 */
export type DesktopProfilePurpose =
  | 'app_state'
  | 'sync_queue'
  | 'meta'
  | 'restore_checkpoint'
  | 'migration_journal';

type ProfileReadResponse = {
  ok: boolean;
  found?: boolean;
  payload?: unknown;
  error?: string;
};

type ProfileWriteResponse = {
  ok: boolean;
  revision?: number;
  bytes?: number;
  error?: string;
};

type DesktopProfileApi = {
  isDesktop?: boolean;
  readPOSProfileData?: (purpose: DesktopProfilePurpose) => Promise<ProfileReadResponse>;
  writePOSProfileData?: (purpose: DesktopProfilePurpose, payload: string) => Promise<ProfileWriteResponse>;
};

function desktopApi(): DesktopProfileApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as Window & { nexfixDesktop?: DesktopProfileApi }).nexfixDesktop;
  if (!api?.isDesktop) return null;
  if (typeof api.readPOSProfileData !== 'function' ||
      typeof api.writePOSProfileData !== 'function') {
    throw new Error('Encrypted POS profile bridge is unavailable in this desktop build.');
  }
  return api;
}

/** True only in Electron; browser/dev remains on its existing storage path. */
export function hasDesktopProfileRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { nexfixDesktop?: DesktopProfileApi }).nexfixDesktop?.isDesktop);
}

/**
 * Read an encrypted profile payload. A missing file is distinct from an IPC,
 * unlock, decrypt or parse failure; failures are thrown and must block desktop
 * startup rather than falling back to plaintext IndexedDB or seed data.
 */
export async function readDesktopProfilePayload(
  purpose: DesktopProfilePurpose,
): Promise<string | null> {
  const api = desktopApi();
  if (!api) throw new Error('Encrypted POS profile storage is available only in the desktop app.');
  const response = await api.readPOSProfileData!(purpose);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || 'Encrypted POS profile read failed.');
  }
  if (response.found === false) return null;
  if (response.found !== true || typeof response.payload !== 'string') {
    throw new Error('Encrypted POS profile returned an invalid read response.');
  }
  return response.payload;
}

/** Serialize and persist one encrypted profile payload through trusted IPC. */
export async function writeDesktopProfilePayload(
  purpose: DesktopProfilePurpose,
  serializedPayload: string,
): Promise<{ revision: number; bytes: number }> {
  if (typeof serializedPayload !== 'string') {
    throw new Error('Encrypted POS profile payload must be a serialized string.');
  }
  const api = desktopApi();
  if (!api) throw new Error('Encrypted POS profile storage is available only in the desktop app.');
  const response = await api.writePOSProfileData!(purpose, serializedPayload);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || 'Encrypted POS profile write failed.');
  }
  if (!Number.isSafeInteger(response.revision) || (response.revision || 0) < 1 ||
      !Number.isSafeInteger(response.bytes) || (response.bytes || 0) < 0) {
    throw new Error('Encrypted POS profile returned an invalid write confirmation.');
  }
  return { revision: response.revision!, bytes: response.bytes! };
}

export async function readDesktopProfileJson<T>(
  purpose: DesktopProfilePurpose,
): Promise<T | null> {
  const serialized = await readDesktopProfilePayload(purpose);
  if (serialized === null) return null;
  try {
    return JSON.parse(serialized) as T;
  } catch {
    throw new Error('Encrypted POS profile payload contains invalid JSON.');
  }
}

export async function writeDesktopProfileJson(
  purpose: DesktopProfilePurpose,
  value: unknown,
): Promise<{ revision: number; bytes: number }> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('POS profile data could not be serialized safely.');
  }
  if (typeof serialized !== 'string') {
    throw new Error('POS profile data did not produce a valid JSON payload.');
  }
  return writeDesktopProfilePayload(purpose, serialized);
}
