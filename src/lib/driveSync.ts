/**
 * Google Sheets / Apps Script sync for Nexfix POS
 * - Live table sync (Products, Sales, Customers, …)
 * - Full JSON state backup to Google (action: backupState)
 * URL can be set in Settings or falls back to the default deploy URL.
 */

const DEFAULT_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwqgFn-6tKzAIYsaIT2zLAG6rsmCRPvqQ0iHfL4som0Pb1VoJbceaNG1EciTnpb4Yg/exec';

const URL_KEY = 'nexfix_google_script_url';
const ENABLED_KEY = 'nexfix_google_sync_enabled';

export function getGoogleScriptUrl(): string {
  try {
    const fromLs = localStorage.getItem(URL_KEY);
    if (fromLs && fromLs.startsWith('https://script.google.com')) return fromLs;
  } catch { /* ignore */ }
  return DEFAULT_SCRIPT_URL;
}

export function setGoogleScriptUrl(url: string): void {
  try {
    if (url.trim()) localStorage.setItem(URL_KEY, url.trim());
    else localStorage.removeItem(URL_KEY);
  } catch { /* ignore */ }
}

export function isGoogleSyncEnabled(): boolean {
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    // default ON if never set (keeps previous behaviour)
    if (v === null) return true;
    return v === '1' || v === 'true';
  } catch {
    return true;
  }
}

export function setGoogleSyncEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch { /* ignore */ }
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

/**
 * Append / upsert rows into a named sheet tab.
 * tableName examples: Products, SalesHistory, Customers, Expenses, Repairs
 */
export async function syncToGoogleDrive(tableName: string, dataRows: unknown[]): Promise<boolean> {
  if (!dataRows || dataRows.length === 0) return false;
  const ok = await postToScript({
    action: 'saveData',
    table: tableName,
    rows: dataRows,
  });
  if (ok) console.log(`[Google Sheet Sync] sent ${dataRows.length} row(s) → ${tableName}`);
  return ok;
}

/**
 * Full POS state backup to Google (single JSON blob).
 * Apps Script should handle action === 'backupState' and store in a Backup sheet or Drive file.
 */
export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  const ok = await postToScript({
    action: 'backupState',
    kind,
    exportedAt: new Date().toISOString(),
    state,
  });
  if (ok) console.log(`[Google Backup] full state (${kind}) sent`);
  return ok;
}

/** Fetch rows from a sheet tab (requires CORS-enabled script response) */
export async function fetchFromGoogleDrive(tableName: string): Promise<unknown[]> {
  try {
    const url = `${getGoogleScriptUrl()}?table=${encodeURIComponent(tableName)}`;
    const response = await fetch(url);
    const data = await response.json();
    return Array.isArray(data) ? data : data?.rows || [];
  } catch (error) {
    console.error(`[Google Sheet Fetch] ${tableName}`, error);
    return [];
  }
}
