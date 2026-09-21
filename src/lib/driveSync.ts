/** Direct Google Drive backup integration for Nexfix POS.
 * POS -> Google Apps Script Web App -> dedicated Google Drive folder.
 * This backup path does not use Supabase.
 */

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const ENV_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();
const CLOUD_SAFE_MARKER = '__nexfixCloudSafe';

function isAllowedScriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com'
      && /^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname);
  } catch { return false; }
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
    throw new Error('Invalid Google Apps Script Web App URL. Use the deployed /macros/s/.../exec URL.');
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
    return isAllowedScriptUrl(ENV_URL);
  } catch { return isAllowedScriptUrl(ENV_URL); }
}

export function setGoogleSyncEnabled(on: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

function getLocalShopId(): string {
  try {
    const id = (localStorage.getItem(SHOP_KEY) || '').trim();
    return id.length > 0 && id.length <= 100 ? id : '';
  } catch { return ''; }
}

function makeRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `nexfix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

/** Direct fire-and-forget backup. Apps Script receives text/plain to avoid a CORS preflight. */
export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  if (!isGoogleSyncEnabled() || !getGoogleScriptUrl()) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  const shopId = getLocalShopId();
  if (!shopId) return false;

  const sanitized = sanitizeCloudBackup(state);
  const backupState = sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    && 'state' in (sanitized as Record<string, unknown>)
    ? (sanitized as Record<string, unknown>).state : sanitized;

  const payload = {
    action: 'backupState',
    shopId,
    requestId: makeRequestId(),
    kind,
    exportedAt: new Date().toISOString(),
    state: backupState,
  };

  try {
    await fetch(getGoogleScriptUrl(), {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    return true;
  } catch (error) {
    console.error('[Google Backup] direct request failed', error);
    return false;
  }
}

/** Table sync is intentionally disabled in the direct Drive-only backup mode. */
export async function syncToGoogleDrive(_tableName: string, _dataRows: unknown[]): Promise<boolean> {
  return false;
}

export async function fetchFromGoogleDrive(_tableName: string): Promise<unknown[]> {
  return [];
}

/** Read the latest backup directly from Apps Script using JSONP (no Supabase proxy). */
export async function fetchLatestGoogleBackup(): Promise<{ state: unknown; backedUpAt?: string; kind?: string } | null> {
  if (!isGoogleSyncEnabled() || !getGoogleScriptUrl()) return null;
  const shopId = getLocalShopId();
  if (!shopId) return null;

  return new Promise((resolve) => {
    const callbackName = `__nexfixGoogleBackup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => {
      try { delete (window as unknown as Record<string, unknown>)[callbackName]; } catch { /* ignore */ }
      script.remove();
    };
    const timer = window.setTimeout(() => { cleanup(); resolve(null); }, 30000);

    (window as unknown as Record<string, unknown>)[callbackName] = (result: unknown) => {
      window.clearTimeout(timer);
      cleanup();
      if (!result || typeof result !== 'object') return resolve(null);
      const data = result as { ok?: boolean; backup?: { state?: unknown; timestamp?: unknown; backupType?: unknown } };
      if (data.ok !== true || !data.backup || typeof data.backup.state !== 'string') return resolve(null);
      try {
        const parsed: unknown = JSON.parse(data.backup.state);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return resolve(null);
        resolve({
          state: { [CLOUD_SAFE_MARKER]: true, state: parsed },
          backedUpAt: typeof data.backup.timestamp === 'string' ? data.backup.timestamp : undefined,
          kind: data.backup.backupType === 'manual' || data.backup.backupType === 'auto' ? data.backup.backupType : undefined,
        });
      } catch { resolve(null); }
    };

    const url = new URL(getGoogleScriptUrl());
    url.searchParams.set('action', 'getLatestBackup');
    url.searchParams.set('shopId', shopId);
    url.searchParams.set('callback', callbackName);
    script.async = true;
    script.src = url.toString();
    script.onerror = () => { window.clearTimeout(timer); cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}
