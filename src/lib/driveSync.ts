/** Direct Google Drive backup integration for Nexfix POS.
 * POS -> Google Apps Script Web App -> dedicated Google Drive folder.
 * This backup path does not use Supabase.
 */

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
// Central deployment: customers do not need to configure or receive the URL.
// The Web App URL is a transport address, not a secret.
const BUILT_IN_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby1z0HyyJ2Nzs7hhyUFGedd_wjKoKT-FpWAikjJBRGPRNZrUt5ZF8Q5s04UwcNF7pNxRQ/exec';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const DRIVE_SHOP_KEY = 'nexfix_drive_shop_id';
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
  return isAllowedScriptUrl(BUILT_IN_SCRIPT_URL) ? BUILT_IN_SCRIPT_URL : '';
}

export function setGoogleScriptUrl(_url: string): void {
  // Kept for backwards compatibility with older builds; the deployment is centrally managed.
  try { localStorage.removeItem(URL_KEY); } catch { /* ignore */ }
}

export function isGoogleSyncEnabled(): boolean {
  return isAllowedScriptUrl(BUILT_IN_SCRIPT_URL);
}

export function setGoogleSyncEnabled(_on: boolean): void {
  // Google backup is centrally managed and remains enabled for the released POS build.
  try { localStorage.removeItem(ENABLED_KEY); } catch { /* ignore */ }
}

/**
 * Return the Supabase shop id when one exists. Private/offline users do not have
 * a cloud shop id, so Drive backup gets its own stable browser-local id instead.
 * Never write a generated Drive id into nexfix_cloud_shop_id.
 */
function getLocalShopId(): string {
  try {
    const cloudId = (localStorage.getItem(SHOP_KEY) || '').trim();
    if (cloudId.length > 0 && cloudId.length <= 100) return cloudId;

    const existingDriveId = (localStorage.getItem(DRIVE_SHOP_KEY) || '').trim();
    if (existingDriveId.length > 0 && existingDriveId.length <= 100) return existingDriveId;

    let driveId = '';
    try {
      if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        driveId = `drive-${crypto.randomUUID()}`;
      }
    } catch { /* ignore */ }

    if (!driveId) {
      driveId = `drive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    localStorage.setItem(DRIVE_SHOP_KEY, driveId);
    return driveId;
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

/** Direct backup. POST avoids a CORS preflight; a JSONP status check confirms Drive actually accepted it. */
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
    // Google Apps Script web apps commonly redirect the /exec URL before
    // handling the request. A cross-origin fetch can turn that redirected POST
    // into a GET, so use a native HTML form POST instead. The form POST is a
    // browser-supported cross-origin navigation and reliably reaches doPost.
    const iframeName = 'nexfixGoogleBackupFrame_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const iframe = document.createElement('iframe');
    iframe.name = iframeName;
    iframe.style.display = 'none';
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = getGoogleScriptUrl();
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
    window.setTimeout(() => {
      form.remove();
      iframe.remove();
    }, 30000);

    // The iframe response is cross-origin and intentionally ignored. Confirm
    // the server-side Drive write through the JSONP status endpoint instead.
    const baseUrl = getGoogleScriptUrl();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const status = await getGoogleBackupRequestStatus(baseUrl, shopId, payload.requestId);
      if (status === true) return true;
      if (status === false) return false;
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    console.error('[Google Backup] Drive confirmation timed out');
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
