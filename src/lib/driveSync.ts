/**
 * Google Apps Script / Drive backup integration.
 *
 * The deployment URL is the one supplied with the original Nexfix POS project.
 * It is only used after Google Sync is explicitly enabled in Settings.
 * The URL is validated to prevent accidental non-Google endpoints.
 *
 * Note: Google Apps Script web apps are commonly called with `no-cors` from
 * browser builds, so a POST can confirm dispatch but cannot expose the script's
 * JSON response to the browser. We therefore treat a successful fetch dispatch
 * as "sent", while server-side Apps Script logging remains the source of truth.
 */

const DEFAULT_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwqgFn-6tKzAIYsaIT2zLAG6rsmCRPvqQ0iHfL4som0Pb1VoJbceaNG1EciTnpb4Yg/exec';
const URL_KEY = 'nexfix_google_script_url';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const ENV_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();

function isAllowedScriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com';
  } catch {
    return false;
  }
}

export function getGoogleScriptUrl(): string {
  try {
    const fromLs = localStorage.getItem(URL_KEY) || '';
    if (isAllowedScriptUrl(fromLs)) return fromLs;
  } catch {
    // Ignore unavailable storage.
  }

  if (isAllowedScriptUrl(ENV_URL)) return ENV_URL;
  return isAllowedScriptUrl(DEFAULT_SCRIPT_URL) ? DEFAULT_SCRIPT_URL : '';
}

export function setGoogleScriptUrl(url: string): void {
  const value = url.trim();
  if (value && !isAllowedScriptUrl(value)) {
    throw new Error('Google Apps Script URL must be an HTTPS script.google.com URL.');
  }
  try {
    if (value) localStorage.setItem(URL_KEY, value);
    else localStorage.removeItem(URL_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

export function isGoogleSyncEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setGoogleSyncEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    // Ignore unavailable storage.
  }
}

async function postToScript(body: Record<string, unknown>): Promise<boolean> {
  if (!isGoogleSyncEnabled()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

  const url = getGoogleScriptUrl();
  if (!url) return false;

  try {
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    return true;
  } catch (error) {
    console.error('[Google Sync] failed', error);
    return false;
  }
}

export async function syncToGoogleDrive(tableName: string, dataRows: unknown[]): Promise<boolean> {
  if (!dataRows?.length) return false;
  return postToScript({ action: 'saveData', table: tableName, rows: dataRows });
}

export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  return postToScript({
    action: 'backupState',
    kind,
    exportedAt: new Date().toISOString(),
    state,
  });
}

export async function fetchFromGoogleDrive(tableName: string): Promise<unknown[]> {
  const base = getGoogleScriptUrl();
  if (!base || !isGoogleSyncEnabled()) return [];
  try {
    const url = `${base}?table=${encodeURIComponent(tableName)}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : data?.rows || [];
  } catch (error) {
    console.error(`[Google Sheet Fetch] ${tableName}`, error);
    return [];
  }
}
