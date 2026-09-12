/**
 * Authenticated Google Apps Script backup/restore integration.
 *
 * The browser never stores or sends a shared Google API key. Requests are
 * authorized by the signed-in Supabase user and proxied server-side through
 * the authenticated google-backup-proxy Edge Function.
 */

import { supabase } from './supabase';

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const ENV_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();

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
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
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

  try {
    const { data, error } = await supabase.functions.invoke('google-backup-proxy', {
      body: { ...body, scriptUrl: getGoogleScriptUrl(), requestId: makeRequestId() },
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

export async function syncToGoogleDrive(tableName: string, dataRows: unknown[]): Promise<boolean> {
  if (!dataRows?.length) return false;
  const result = await invokeProxy({ action: 'saveData', table: tableName, rows: dataRows });
  return result?.ok === true;
}

export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  const result = await invokeProxy({
    action: 'backupState',
    kind,
    exportedAt: new Date().toISOString(),
    state,
  });
  return result?.ok === true;
}

export async function fetchFromGoogleDrive(tableName: string): Promise<unknown[]> {
  const result = await invokeProxy({ action: 'getTable', table: tableName });
  return result?.ok === true && Array.isArray(result.rows) ? result.rows : [];
}

/** Read the latest FullBackup row through the authenticated proxy. */
export async function fetchLatestGoogleBackup(): Promise<{ state: unknown; backedUpAt?: string; kind?: string } | null> {
  const result = await invokeProxy({ action: 'getLatestBackup' });
  if (result?.ok !== true || !result.backup || typeof result.backup !== 'object') return null;

  const backup = result.backup as { state?: unknown; timestamp?: unknown; backupType?: unknown };
  if (typeof backup.state !== 'string') return null;
  try {
    return {
      state: JSON.parse(backup.state),
      backedUpAt: typeof backup.timestamp === 'string' ? backup.timestamp : undefined,
      kind: typeof backup.backupType === 'string' ? backup.backupType : undefined,
    };
  } catch {
    return null;
  }
}
