/**
 * Authenticated Google Apps Script backup/restore integration.
 *
 * The browser never stores or sends a shared Google API key. Requests are
 * authorized by the signed-in Supabase user and proxied server-side through
 * the authenticated google-backup-proxy Edge Function.
 *
 * Every Google backup request is explicitly scoped to the currently selected
 * Nexfix shop so installations can support many shops and many PCs safely.
 */

import { supabase } from './supabase';
import { getCloudShopId } from './cloudSync';

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const ENV_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();
const CLOUD_SAFE_MARKER = '__nexfixCloudSafe';

function isAllowedScriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'script.google.com'
      && /^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function getGoogleScriptUrl(): string {
  try {
    const fromLs = localStorage.getItem(URL_KEY) || '';
    if (isAllowedScriptUrl(fromLs)) return fromLs;
  } catch { /* ignore */ }
  return isAllowedScriptUrl(ENV_URL) ? ENV_URL : '';
}

export function setGoogleScriptUrl(url: string): void {
  const value = url.trim();
  if (value && !isAllowedScriptUrl(value)) {
    throw new Error('Invalid Google Apps Script Web App URL. Use the deployed /macros/s/.../exec URL, not a /macros/library/d/... URL.');
  }
  try {
    if (value) localStorage.setItem(URL_KEY, value);
    else localStorage.removeItem(URL_KEY);
  } catch { /* ignore */ }
}

export function isGoogleSyncEnabled(): boolean {
  try {
    const stored = localStorage.getItem(ENABLED_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
    // A deployment-provided Apps Script URL opts the installation into the
    // configured automatic backup flow without requiring a second toggle.
    return isAllowedScriptUrl(ENV_URL);
  } catch {
    return isAllowedScriptUrl(ENV_URL);
  }
}

export function setGoogleSyncEnabled(on: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

function makeRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `nexfix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function invokeProxy(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!supabase || !isGoogleSyncEnabled() || !getGoogleScriptUrl()) return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;

  const shopId = getCloudShopId();
  if (!shopId) return null;

  try {
    const { data, error } = await supabase.functions.invoke('google-backup-proxy', {
      body: {
        ...body,
        shopId,
        scriptUrl: getGoogleScriptUrl(),
        requestId: makeRequestId(),
      },
    });
    if (error || !data || typeof data !== 'object') {
      console.error('[Google Sync] proxy failed', error);
      return null;
    }
    return data as Record<string, unknown>;
  } catch (error) {
    console.error('[Google Sync] proxy failed', error);
    return null;
  }
}

/**
 * Google Drive is a secondary backup location, not an authentication store.
 * Local user records, password hashes and the admin PIN are intentionally not
 * exported there. Restore keeps the current device's complete auth state.
 */
function sanitizeCloudBackup(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const envelope = input as Record<string, unknown>;
  const stateValue = envelope.state;
  if (!stateValue || typeof stateValue !== 'object' || Array.isArray(stateValue)) return input;

  const state = stateValue as Record<string, unknown>;
  const safeState: Record<string, unknown> = { ...state, users: [] };
  if (state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings)) {
    safeState.settings = { ...(state.settings as Record<string, unknown>), adminPinHash: '' };
  }

  return { ...envelope, state: safeState, [CLOUD_SAFE_MARKER]: true };
}

export function isCloudSafeBackup(input: unknown): boolean {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>)[CLOUD_SAFE_MARKER] === true;
}

export async function syncToGoogleDrive(tableName: string, dataRows: unknown[]): Promise<boolean> {
  if (!dataRows?.length) return false;
  const result = await invokeProxy({ action: 'saveData', table: tableName, rows: dataRows });
  return result?.ok === true;
}

export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  const sanitized = sanitizeCloudBackup(state);
  const backupState = sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    && 'state' in (sanitized as Record<string, unknown>)
    ? (sanitized as Record<string, unknown>).state
    : sanitized;
  const result = await invokeProxy({
    action: 'backupState',
    kind,
    exportedAt: new Date().toISOString(),
    state: backupState,
  });
  return result?.ok === true;
}

export async function fetchFromGoogleDrive(tableName: string): Promise<unknown[]> {
  const result = await invokeProxy({ action: 'getTable', table: tableName });
  return result?.ok === true && Array.isArray(result.rows) ? result.rows : [];
}

/** Read the latest FullBackup row for the currently selected shop. */
export async function fetchLatestGoogleBackup(): Promise<{ state: unknown; backedUpAt?: string; kind?: string } | null> {
  const result = await invokeProxy({ action: 'getLatestBackup' });
  if (result?.ok !== true || !result.backup || typeof result.backup !== 'object') return null;

  const backup = result.backup as { state?: unknown; timestamp?: unknown; backupType?: unknown };
  if (typeof backup.state !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(backup.state);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const backedUpAt = typeof backup.timestamp === 'string' && Number.isFinite(Date.parse(backup.timestamp))
      ? backup.timestamp
      : undefined;
    const kind = backup.backupType === 'manual' || backup.backupType === 'auto'
      ? backup.backupType
      : undefined;
    return {
      state: { [CLOUD_SAFE_MARKER]: true, state: parsed },
      backedUpAt,
      kind,
    };
  } catch {
    return null;
  }
}
