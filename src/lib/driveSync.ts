/** Direct Google Drive backup integration for Nexfix POS.
 * POS -> Google Apps Script Web App -> dedicated Google Drive folder.
 * Business-state encryption happens in the browser before anything is uploaded.
 */

import {
  decryptBackupEnvelope,
  encryptBackupState,
  isEncryptedBackupEnvelope,
  sha256Hex,
} from './backupCrypto';

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const BUILT_IN_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby1z0HyyJ2Nzs7hhyUFGedd_wjKoKT-FpWAikjJBRGPRNZrUt5ZF8Q5s04UwcNF7pNxRQ/exec';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const DRIVE_SHOP_KEY = 'nexfix_drive_shop_id';
const DRIVE_SHOP_OVERRIDE_KEY = 'nexfix_drive_shop_id_override';
const CLOUD_SAFE_MARKER = '__nexfixCloudSafe';
const SINGLE_LIMIT_BYTES = 8.5 * 1024 * 1024;
const PART_SIZE_CHARS = 6 * 1024 * 1024;

function isAllowedScriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com'
      && /^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname);
  } catch { return false; }
}

export function getGoogleScriptUrl(): string {
  return isAllowedScriptUrl(BUILT_IN_SCRIPT_URL) ? BUILT_IN_SCRIPT_URL : '';
}

export function setGoogleScriptUrl(_url: string): void {
  try { localStorage.removeItem(URL_KEY); } catch { /* ignore */ }
}

export function isGoogleSyncEnabled(): boolean {
  return isAllowedScriptUrl(BUILT_IN_SCRIPT_URL);
}

export function setGoogleSyncEnabled(_on: boolean): void {
  try { localStorage.removeItem(ENABLED_KEY); } catch { /* ignore */ }
}

export function getLocalShopId(): string {
  try {
    const recoveryOverride = (localStorage.getItem(DRIVE_SHOP_OVERRIDE_KEY) || '').trim();
    if (recoveryOverride.length > 0 && recoveryOverride.length <= 100 && SHOP_ID_PATTERN.test(recoveryOverride)) return recoveryOverride;
    const cloudId = (localStorage.getItem(SHOP_KEY) || '').trim();
    if (cloudId.length > 0 && cloudId.length <= 100) return cloudId;
    const existingDriveId = (localStorage.getItem(DRIVE_SHOP_KEY) || '').trim();
    if (existingDriveId.length > 0 && existingDriveId.length <= 100) return existingDriveId;

    let driveId = '';
    try {
      if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) driveId = `drive-${crypto.randomUUID()}`;
    } catch { /* ignore */ }
    if (!driveId) driveId = `drive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DRIVE_SHOP_KEY, driveId);
    return driveId;
  } catch { return ''; }
}

export function getDriveShopId(): string {
  try {
    return (localStorage.getItem(DRIVE_SHOP_OVERRIDE_KEY) || localStorage.getItem(DRIVE_SHOP_KEY) || '').trim();
  } catch { return ''; }
}

export function adoptBackupShopId(input: string): { ok: boolean; error?: string } {
  return setExistingDriveShopId(input, true);
}

const SHOP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

export function setExistingDriveShopId(input: string, recoveryOverride = true): { ok: boolean; error?: string } {
  const value = input.trim();
  if (!value) return { ok: false, error: 'Shop Backup ID is required' };
  if (value.length > 100 || !SHOP_ID_PATTERN.test(value)) {
    return { ok: false, error: 'Shop Backup ID must be 1–100 characters: letters, numbers, dot, underscore, colon, or hyphen.' };
  }
  try {
    localStorage.setItem(DRIVE_SHOP_KEY, value);
    if (recoveryOverride) localStorage.setItem(DRIVE_SHOP_OVERRIDE_KEY, value);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not save Shop Backup ID on this browser.' };
  }
}

function makeRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `nexfix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeBackupId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeCloudState(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const state = input as Record<string, unknown>;
  const safeState: Record<string, unknown> = { ...state, users: [] };
  if (state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings)) {
    safeState.settings = { ...(state.settings as Record<string, unknown>), adminPinHash: '' };
  }
  return safeState;
}

export function isCloudSafeBackup(input: unknown): boolean {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>)[CLOUD_SAFE_MARKER] === true;
}

function getDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Split a JSON string into UTF-8 byte-safe chunks.
 * JavaScript string length is UTF-16 code units, so slicing by character count
 * can exceed the Apps Script Drive part-size limit when the payload contains
 * non-ASCII shop/product/customer text.
 */
function splitUtf8Chunks(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;

  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > 0 && bytes + width > maxBytes) {
      chunks.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += codePoint > 0xffff ? 2 : 1;
  }

  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

async function postGoogleBackup(body: Record<string, unknown>, shopId: string): Promise<boolean> {
  const baseUrl = getGoogleScriptUrl();
  if (!baseUrl) return false;
  const requestId = makeRequestId();
  const payload = { action: 'backupState', shopId, requestId, ...body };

  try {
    const iframeName = 'nexfixGoogleBackupFrame_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const iframe = document.createElement('iframe');
    iframe.name = iframeName;
    iframe.style.display = 'none';
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = baseUrl;
    form.target = iframeName;
    form.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = JSON.stringify(payload);
    form.appendChild(input);
    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
    window.setTimeout(() => { form.remove(); iframe.remove(); }, 60000);

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const status = await getGoogleBackupRequestStatus(baseUrl, shopId, requestId);
      if (status === true) return true;
      if (status === false) return false;
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    console.error('[Google Backup] confirmation timed out');
    return false;
  } catch (error) {
    console.error('[Google Backup] direct request failed', error);
    return false;
  }
}

async function getGoogleBackupRequestStatus(baseUrl: string, shopId: string, requestId: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const callbackName = `__nexfixGoogleBackupStatus_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { delete (window as unknown as Record<string, unknown>)[callbackName]; } catch { /* ignore */ }
      script.remove();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    (window as unknown as Record<string, unknown>)[callbackName] = (result: unknown) => {
      if (!result || typeof result !== 'object') return finish(null);
      const data = result as { ok?: boolean; pending?: boolean; status?: string };
      if (data.ok === true && data.status === 'success') return finish(true);
      if (data.status === 'pending') return finish(null);
      finish(false);
    };
    const url = new URL(baseUrl);
    url.searchParams.set('action', 'backupStatus');
    url.searchParams.set('shopId', shopId);
    url.searchParams.set('requestId', requestId);
    url.searchParams.set('callback', callbackName);
    script.async = true;
    script.src = url.toString();
    script.onerror = () => finish(null);
    document.head.appendChild(script);
  });
}

export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  if (!isGoogleSyncEnabled() || !getGoogleScriptUrl()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  const shopId = getLocalShopId();
  if (!shopId) return false;

  try {
    const source = state && typeof state === 'object' && !Array.isArray(state)
      ? state as Record<string, unknown>
      : {};
    const businessState = source.state && typeof source.state === 'object' && !Array.isArray(source.state)
      ? source.state
      : state;
    const safeState = sanitizeCloudState(businessState);
    const exportedAt = new Date().toISOString();
    const envelope = await encryptBackupState(safeState, shopId, kind, exportedAt);
    const serialized = JSON.stringify(envelope);
    const totalBytes = utf8Bytes(serialized);
    const backupId = makeBackupId();
    const dayKey = getDayKey();
    const businessRecord = safeState && typeof safeState === 'object' && !Array.isArray(safeState) ? safeState as Record<string, unknown> : {};
    const settings = businessRecord.settings && typeof businessRecord.settings === 'object' && !Array.isArray(businessRecord.settings)
      ? businessRecord.settings as Record<string, unknown>
      : {};
    const shopName = String(settings.shopName || 'Shop');

    if (totalBytes <= SINGLE_LIMIT_BYTES) {
      return await postGoogleBackup({
        format: 'encrypted-single',
        dayKey,
        backupId,
        exportedAt,
        state: serialized,
        shopName,
      }, shopId);
    }

    const chunks = splitUtf8Chunks(serialized, PART_SIZE_CHARS);
    const totalParts = chunks.length;
    const sha256 = await sha256Hex(serialized);
    const partition = (await sha256Hex(shopId)).slice(0, 24);
    const partNames: string[] = [];

    for (let index = 0; index < totalParts; index += 1) {
      const partName = `NEXFIX_${partition}_${dayKey}.part${String(index + 1).padStart(3, '0')}`;
      partNames.push(partName);
      const chunk = chunks[index];
      const ok = await postGoogleBackup({
        format: 'encrypted-part',
        dayKey,
        backupId,
        partIndex: index + 1,
        totalParts,
        partName,
        totalBytes,
        sha256,
        chunk,
        exportedAt,
        encrypted: true,
        shopName,
      }, shopId);
      if (!ok) {
        console.error('[Google Backup] multipart upload failed at part', index + 1);
        return false;
      }
    }

    return await postGoogleBackup({
      format: 'encrypted-manifest',
      dayKey,
      backupId,
      totalParts,
      totalBytes,
      partSize: PART_SIZE_CHARS,
      partNames,
      sha256,
      exportedAt,
      kind,
      encrypted: true,
      shopName,
    }, shopId);
  } catch (error) {
    console.error('[Google Backup] encryption/upload failed', error);
    return false;
  }
}

export async function syncToGoogleDrive(_tableName: string, _dataRows: unknown[]): Promise<boolean> {
  return false;
}

export async function fetchFromGoogleDrive(_tableName: string): Promise<unknown[]> {
  return [];
}

interface LatestGoogleBackup {
  state: unknown;
  backedUpAt?: string;
  kind?: string;
  shopId?: string;
  shopPartition?: string;
  shopName?: string;
  encrypted?: boolean;
  multipart?: boolean;
  manifest?: {
    backupId: string;
    totalBytes: number;
    totalParts: number;
    partNames: string[];
    sha256: string;
    exportedAt: string;
  };
}

function getJsonp<T>(url: URL, timeoutMs = 30000): Promise<T | null> {
  return new Promise((resolve) => {
    const callbackName = `__nexfixGoogleBackup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => {
      try { delete (window as unknown as Record<string, unknown>)[callbackName]; } catch { /* ignore */ }
      script.remove();
    };
    const timer = window.setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    (window as unknown as Record<string, unknown>)[callbackName] = (result: T) => {
      window.clearTimeout(timer);
      cleanup();
      resolve(result);
    };
    url.searchParams.set('callback', callbackName);
    script.async = true;
    script.src = url.toString();
    script.onerror = () => { window.clearTimeout(timer); cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}

export async function fetchLatestGoogleBackup(): Promise<LatestGoogleBackup | null> {
  if (!isGoogleSyncEnabled() || !getGoogleScriptUrl()) return null;
  const shopId = getLocalShopId();
  if (!shopId) return null;

  try {
    const url = new URL(getGoogleScriptUrl());
    url.searchParams.set('action', 'getLatestBackup');
    url.searchParams.set('shopId', shopId);
    const result = await getJsonp<{
      ok?: boolean;
      backup?: {
        state?: unknown;
        timestamp?: unknown;
        backupType?: unknown;
        shopId?: unknown;
        shopPartition?: unknown;
        shopName?: unknown;
        encrypted?: unknown;
        multipart?: unknown;
        manifest?: LatestGoogleBackup['manifest'];
      };
    }>(url);
    if (!result?.ok || !result.backup) return null;
    const backup = result.backup;
    if (typeof backup.shopId !== 'string' || typeof backup.shopPartition !== 'string') return null;
    if (backup.shopId !== shopId) throw new Error('Restore refused: Google backup belongs to a different shop.');

    let rawPayload = '';
    if (backup.multipart && backup.manifest) {
      const manifest = backup.manifest;
      if (!manifest.backupId || !Number.isInteger(manifest.totalParts) || manifest.totalParts < 1 || manifest.partNames.length !== manifest.totalParts) {
        throw new Error('Invalid multipart backup manifest. Restore was not performed.');
      }
      const chunks: string[] = [];
      for (let index = 0; index < manifest.totalParts; index += 1) {
        const partUrl = new URL(getGoogleScriptUrl());
        partUrl.searchParams.set('action', 'getBackupPart');
        partUrl.searchParams.set('shopId', shopId);
        partUrl.searchParams.set('backupId', manifest.backupId);
        partUrl.searchParams.set('partName', manifest.partNames[index]);
        const part = await getJsonp<{ ok?: boolean; chunk?: unknown }>(partUrl, 30000);
        if (!part?.ok || typeof part.chunk !== 'string') throw new Error(`Missing backup part ${index + 1}.`);
        chunks.push(part.chunk);
      }
      rawPayload = chunks.join('');
      if (utf8Bytes(rawPayload) !== manifest.totalBytes) throw new Error('Multipart backup size verification failed.');
      if (await sha256Hex(rawPayload) !== manifest.sha256) throw new Error('Multipart backup integrity check failed. Restore was not performed.');
    } else {
      if (typeof backup.state !== 'string') return null;
      rawPayload = backup.state;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(rawPayload); } catch { throw new Error('Backup payload is not valid JSON.'); }

    if (backup.encrypted || isEncryptedBackupEnvelope(parsed)) {
      if (!isEncryptedBackupEnvelope(parsed)) throw new Error('Encrypted backup metadata is invalid.');
      if (parsed.shopId !== shopId) throw new Error('Restore refused: encrypted backup belongs to a different shop.');
      const decrypted = await decryptBackupEnvelope(parsed);
      if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) throw new Error('Decrypted backup state is invalid.');
      return {
        state: { [CLOUD_SAFE_MARKER]: true, state: decrypted },
        backedUpAt: typeof backup.timestamp === 'string' ? backup.timestamp : undefined,
        kind: backup.backupType === 'manual' || backup.backupType === 'auto' ? backup.backupType : undefined,
        shopId,
        shopPartition: backup.shopPartition,
        shopName: typeof backup.shopName === 'string' ? backup.shopName : undefined,
        encrypted: true,
        multipart: !!backup.multipart,
        manifest: backup.manifest,
      };
    }

    // Backward compatibility: old small plaintext snapshots are still accepted,
    // then restored through the existing cloud-safe path (local credentials remain local).
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Legacy backup payload is invalid.');
    return {
      state: { [CLOUD_SAFE_MARKER]: true, state: parsed },
      backedUpAt: typeof backup.timestamp === 'string' ? backup.timestamp : undefined,
      kind: backup.backupType === 'manual' || backup.backupType === 'auto' ? backup.backupType : undefined,
      shopId,
      shopPartition: backup.shopPartition,
      shopName: typeof backup.shopName === 'string' ? backup.shopName : undefined,
      encrypted: false,
      multipart: false,
    };
  } catch (error) {
    console.error('[Google Backup] restore read failed', error);
    throw error;
  }
}

export async function getGoogleBackupSecurityStatus(): Promise<{ encrypted: boolean; passphraseRequired: boolean }> {
  return { encrypted: true, passphraseRequired: true };
}
