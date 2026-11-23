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

export type DesktopOverflowFolderStatus = {
  ok: boolean;
  configured: boolean;
  available: boolean;
  folderPath: string | null;
  error?: string;
};

export type DesktopPOSProfileSummary = {
  directory: string;
  profileId: string;
  label: string;
  createdAt?: string;
  updatedAt?: string;
};

export type DesktopPOSProfileDiscovery = {
  ok: boolean;
  root: string;
  available: DesktopPOSProfileSummary[];
  duplicates: Array<{ profileId: string; copies: DesktopPOSProfileSummary[] }>;
  invalid: Array<{ directory: string; error: string }>;
  error?: string;
};

export type DesktopPOSProfileResult = {
  ok: boolean;
  profile?: Pick<DesktopPOSProfileSummary, 'directory' | 'profileId' | 'label'>;
  recoveryKey?: string;
  error?: string;
};

type DesktopProfileApi = {
  isDesktop?: boolean;
  getPOSOverflowFolder?: () => Promise<DesktopOverflowFolderStatus>;
  discoverPOSProfiles?: (storageRoot: string) => Promise<DesktopPOSProfileDiscovery>;
  createPOSProfile?: (payload: { storageRoot: string; directoryName: string; label: string; passphrase: string }) => Promise<DesktopPOSProfileResult>;
  unlockPOSProfileWithOS?: (directory: string) => Promise<DesktopPOSProfileResult>;
  unlockPOSProfileWithPassphrase?: (directory: string, secret: string) => Promise<DesktopPOSProfileResult>;
  unlockPOSProfileWithRecoveryKey?: (directory: string, secret: string) => Promise<DesktopPOSProfileResult>;
  getPOSProfileStatus?: () => Promise<{ ok: boolean; unlocked: boolean; profile?: DesktopPOSProfileSummary; error?: string }>;
  lockPOSProfile?: () => Promise<{ ok: boolean; locked: boolean; error?: string }>;
  readPOSProfileData?: (purpose: DesktopProfilePurpose) => Promise<ProfileReadResponse>;
  writePOSProfileData?: (purpose: DesktopProfilePurpose, payload: string) => Promise<ProfileWriteResponse>;
};

function desktopApi(): DesktopProfileApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as Window & { nexfixDesktop?: DesktopProfileApi }).nexfixDesktop;
  if (!api?.isDesktop) return null;
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
  if (typeof api.readPOSProfileData !== 'function') throw new Error('Encrypted POS profile read bridge is unavailable.');
  const response = await api.readPOSProfileData(purpose);
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
  if (typeof api.writePOSProfileData !== 'function') throw new Error('Encrypted POS profile write bridge is unavailable.');
  const response = await api.writePOSProfileData(purpose, serializedPayload);
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


function requireDesktopProfileApi(): DesktopProfileApi {
  const api = desktopApi();
  if (!api) throw new Error('POS storage profiles are available only in the Windows desktop app.');
  return api;
}

export async function getConfiguredPOSOverflowFolder(): Promise<DesktopOverflowFolderStatus> {
  const api = requireDesktopProfileApi();
  if (typeof api.getPOSOverflowFolder !== 'function') throw new Error('POS overflow-folder bridge is unavailable.');
  const result = await api.getPOSOverflowFolder();
  if (!result || result.ok !== true) throw new Error(result?.error || 'Could not read the selected POS storage folder.');
  return result;
}

export async function discoverDesktopPOSProfiles(storageRoot: string): Promise<DesktopPOSProfileDiscovery> {
  const api = requireDesktopProfileApi();
  if (typeof api.discoverPOSProfiles !== 'function') throw new Error('POS profile discovery bridge is unavailable.');
  const result = await api.discoverPOSProfiles(storageRoot);
  if (!result || result.ok !== true) throw new Error(result?.error || 'Could not scan the selected POS storage folder.');
  return result;
}

export async function createDesktopPOSProfile(input: {
  storageRoot: string;
  directoryName: string;
  label: string;
  passphrase: string;
}): Promise<{ profile: NonNullable<DesktopPOSProfileResult['profile']>; recoveryKey: string }> {
  const api = requireDesktopProfileApi();
  if (typeof api.createPOSProfile !== 'function') throw new Error('POS profile creation bridge is unavailable.');
  const result = await api.createPOSProfile(input);
  if (!result || result.ok !== true || !result.profile || typeof result.recoveryKey !== 'string') {
    throw new Error(result?.error || 'Could not create the encrypted POS storage profile.');
  }
  return { profile: result.profile, recoveryKey: result.recoveryKey };
}

export async function unlockDesktopPOSProfileWithOS(directory: string): Promise<void> {
  const api = requireDesktopProfileApi();
  if (typeof api.unlockPOSProfileWithOS !== 'function') throw new Error('Automatic POS profile unlock is unavailable.');
  const result = await api.unlockPOSProfileWithOS(directory);
  if (!result || result.ok !== true) throw new Error(result?.error || 'Could not unlock the POS storage profile on this Windows account.');
}

export async function unlockDesktopPOSProfileWithPassphrase(directory: string, secret: string): Promise<void> {
  const api = requireDesktopProfileApi();
  if (typeof api.unlockPOSProfileWithPassphrase !== 'function') throw new Error('POS profile passphrase unlock is unavailable.');
  const result = await api.unlockPOSProfileWithPassphrase(directory, secret);
  if (!result || result.ok !== true) throw new Error(result?.error || 'POS profile passphrase unlock failed.');
}

export async function unlockDesktopPOSProfileWithRecoveryKey(directory: string, secret: string): Promise<void> {
  const api = requireDesktopProfileApi();
  if (typeof api.unlockPOSProfileWithRecoveryKey !== 'function') throw new Error('POS profile recovery unlock is unavailable.');
  const result = await api.unlockPOSProfileWithRecoveryKey(directory, secret);
  if (!result || result.ok !== true) throw new Error(result?.error || 'POS profile recovery unlock failed.');
}

export async function getDesktopPOSProfileStatus(): Promise<{ unlocked: boolean; profile?: DesktopPOSProfileSummary }> {
  const api = requireDesktopProfileApi();
  if (typeof api.getPOSProfileStatus !== 'function') throw new Error('POS profile status bridge is unavailable.');
  const result = await api.getPOSProfileStatus();
  if (!result || result.ok !== true) throw new Error(result?.error || 'Could not read POS profile status.');
  return { unlocked: result.unlocked, profile: result.profile };
}

export async function lockDesktopPOSProfile(): Promise<void> {
  const api = requireDesktopProfileApi();
  if (typeof api.lockPOSProfile !== 'function') throw new Error('POS profile lock bridge is unavailable.');
  const result = await api.lockPOSProfile();
  if (!result || result.ok !== true) throw new Error(result?.error || 'Could not lock the POS storage profile.');
}
