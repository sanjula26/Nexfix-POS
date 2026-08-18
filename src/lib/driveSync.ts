/**
 * Google Apps Script / Google Sheets backup integration.
 *
 * Browser-safe transport:
 * - Cross-origin POST uses a hidden form/iframe instead of fetch(no-cors), so
 *   browser CORS/redirect behavior cannot incorrectly report a network failure.
 * - The Apps Script stores an acknowledgement keyed by requestId.
 * - The acknowledgement is read through JSONP, which is intentionally used
 *   only for this public, non-secret status endpoint.
 */

const DEFAULT_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbytyis-RNV9lhVM-v8LdVwnqkvU7O0BfpHBjVjdiVv0P4G8LsJSzjgvh4Wg8S1f27l_/exec';
const URL_KEY = 'nexfix_google_script_url';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const ENV_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();

/** Only a deployed Apps Script Web App URL is valid here.
 * Library URLs such as /macros/library/d/... are NOT Web App endpoints.
 */
function isAllowedScriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') return false;
    return /^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname);
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
    throw new Error('Invalid Google Apps Script Web App URL. Use the deployed /macros/s/.../exec URL, not a /macros/library/d/... URL.');
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

function makeRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through.
  }
  return `nexfix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function submitCrossOriginPost(url: string, body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframeName = `nexfix-post-${makeRequestId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const iframe = document.createElement('iframe');
    iframe.name = iframeName;
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    form.target = iframeName;
    form.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = JSON.stringify(body);
    form.appendChild(input);

    const cleanup = () => {
      window.setTimeout(() => {
        iframe.remove();
        form.remove();
      }, 1000);
    };

    iframe.onload = () => {
      cleanup();
      resolve();
    };
    iframe.onerror = () => {
      cleanup();
      reject(new Error('Google Apps Script POST could not be dispatched.'));
    };

    document.body.appendChild(iframe);
    document.body.appendChild(form);

    try {
      form.submit();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function readJsonpStatus(url: string, requestId: string, timeoutMs = 12000): Promise<boolean> {
  return new Promise((resolve) => {
    const callbackName = `nexfixBackupAck_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      try {
        delete (window as unknown as Record<string, unknown>)[callbackName];
      } catch {
        // Ignore cleanup failure.
      }
      resolve(value);
    };

    const timer = window.setTimeout(() => finish(false), timeoutMs);

    (window as unknown as Record<string, unknown>)[callbackName] = (payload: unknown) => {
      const result = payload as { ok?: boolean; status?: string } | null;
      finish(Boolean(result?.ok && result.status === 'success'));
    };

    script.onerror = () => finish(false);
    script.src = `${url}?action=backupStatus&requestId=${encodeURIComponent(requestId)}&callback=${encodeURIComponent(callbackName)}`;
    document.head.appendChild(script);
  });
}

async function postToScript(body: Record<string, unknown>): Promise<boolean> {
  if (!isGoogleSyncEnabled()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  if (typeof document === 'undefined') return false;

  const url = getGoogleScriptUrl();
  if (!url) return false;

  const requestId = makeRequestId();
  const payload = { ...body, requestId };

  try {
    await submitCrossOriginPost(url, payload);
    return await readJsonpStatus(url, requestId);
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
  if (!base || !isGoogleSyncEnabled() || typeof document === 'undefined') return [];

  return new Promise((resolve) => {
    const callbackName = `nexfixRows_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;

    const finish = (rows: unknown[]) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      try {
        delete (window as unknown as Record<string, unknown>)[callbackName];
      } catch {
        // Ignore cleanup failure.
      }
      resolve(rows);
    };

    const timer = window.setTimeout(() => finish([]), 12000);

    (window as unknown as Record<string, unknown>)[callbackName] = (payload: unknown) => {
      const data = payload as { ok?: boolean; rows?: unknown[] } | null;
      finish(data?.ok && Array.isArray(data.rows) ? data.rows : []);
    };

    script.onerror = () => finish([]);
    script.src = `${base}?action=getTable&table=${encodeURIComponent(tableName)}&callback=${encodeURIComponent(callbackName)}`;
    document.head.appendChild(script);
  });
}
