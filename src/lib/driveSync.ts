/**
 * Google Apps Script / Google Sheets backup/restore integration.
 */

import { supabase } from './supabase';
import { ensureCloudShop } from './cloudSync';

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const API_KEY_STORAGE = 'nexfix_google_api_key_v1';
const ENV_URL = (import.meta.env.VITE_GOOGLE_SCRIPT_URL || '').trim();
const ENV_API_KEY = (import.meta.env.VITE_GOOGLE_SCRIPT_API_KEY || '').trim();

function isAllowedScriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') return false;
    return /^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname);
  } catch { return false; }
}

export function getGoogleScriptUrl(): string {
  try { const fromLs = localStorage.getItem(URL_KEY) || ''; if (isAllowedScriptUrl(fromLs)) return fromLs; } catch { /* ignore */ }
  return isAllowedScriptUrl(ENV_URL) ? ENV_URL : '';
}

export function setGoogleScriptUrl(url: string): void {
  const value = url.trim();
  if (value && !isAllowedScriptUrl(value)) throw new Error('Invalid Google Apps Script Web App URL. Use the deployed /macros/s/.../exec URL, not a /macros/library/d/... URL.');
  try { if (value) localStorage.setItem(URL_KEY, value); else localStorage.removeItem(URL_KEY); } catch { /* ignore */ }
}

export function getGoogleApiKey(): string {
  try {
    const fromLs = localStorage.getItem(API_KEY_STORAGE) || '';
    if (fromLs.trim()) return fromLs.trim();
  } catch { /* ignore */ }
  return ENV_API_KEY;
}

export function setGoogleApiKey(value: string): void {
  const key = value.trim();
  try { if (key) localStorage.setItem(API_KEY_STORAGE, key); else localStorage.removeItem(API_KEY_STORAGE); } catch { /* ignore */ }
}

function requestGoogleApiKey(): string {
  const existing = getGoogleApiKey();
  if (existing || typeof window === 'undefined') return existing;
  try {
    const entered = window.prompt('Enter the Nexfix Google Apps Script API key configured as NEXFIX_API_KEY:');
    if (!entered?.trim()) return '';
    setGoogleApiKey(entered);
    return entered.trim();
  } catch { return ''; }
}

/** Full-state Google backup/restore is restricted to admin/manager members of the active shop. */
async function hasGoogleBackupAccess(): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) return false;
    const shop = await ensureCloudShop('Nexfix Shop');
    if (!shop.ok || !shop.shopId) return false;
    const { data: membership, error } = await supabase
      .from('shop_memberships')
      .select('role')
      .eq('shop_id', shop.shopId)
      .eq('user_id', sessionData.session.user.id)
      .eq('active', true)
      .maybeSingle();
    if (error) return false;
    return membership?.role === 'admin' || membership?.role === 'manager';
  } catch { return false; }
}

export function isGoogleSyncEnabled(): boolean { try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; } }
export function setGoogleSyncEnabled(on: boolean): void { try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ignore */ } }

function makeRequestId(): string {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID(); } catch { /* ignore */ }
  return `nexfix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function submitCrossOriginPost(url: string, body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframeName = `nexfix-post-${makeRequestId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const iframe = document.createElement('iframe'); iframe.name = iframeName; iframe.style.display = 'none'; iframe.setAttribute('aria-hidden', 'true');
    const form = document.createElement('form'); form.method = 'POST'; form.action = url; form.target = iframeName; form.style.display = 'none';
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'payload'; input.value = JSON.stringify(body); form.appendChild(input);
    const cleanup = () => window.setTimeout(() => { iframe.remove(); form.remove(); }, 1000);
    iframe.onload = () => { cleanup(); resolve(); }; iframe.onerror = () => { cleanup(); reject(new Error('Google Apps Script POST could not be dispatched.')); };
    document.body.appendChild(iframe); document.body.appendChild(form);
    try { form.submit(); } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

function readJsonpStatus(url: string, requestId: string, apiKey: string, timeoutMs = 12000): Promise<boolean> {
  return new Promise((resolve) => {
    const callbackName = `nexfixBackupAck_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script'); let settled = false;
    const finish = (value: boolean) => { if (settled) return; settled = true; window.clearTimeout(timer); script.remove(); try { delete (window as unknown as Record<string, unknown>)[callbackName]; } catch { /* ignore */ } resolve(value); };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    (window as unknown as Record<string, unknown>)[callbackName] = (payload: unknown) => { const result = payload as { ok?: boolean; status?: string } | null; finish(Boolean(result?.ok && result.status === 'success')); };
    script.onerror = () => finish(false);
    script.src = `${url}?action=backupStatus&requestId=${encodeURIComponent(requestId)}&apiKey=${encodeURIComponent(apiKey)}&callback=${encodeURIComponent(callbackName)}`;
    document.head.appendChild(script);
  });
}

async function postToScript(body: Record<string, unknown>): Promise<boolean> {
  if (!isGoogleSyncEnabled() || (typeof navigator !== 'undefined' && !navigator.onLine) || typeof document === 'undefined') return false;
  const url = getGoogleScriptUrl(); const apiKey = requestGoogleApiKey();
  if (!url || !apiKey) return false;
  const requestId = makeRequestId();
  try { await submitCrossOriginPost(url, { ...body, requestId, apiKey }); return await readJsonpStatus(url, requestId, apiKey); }
  catch (error) { console.error('[Google Sync] failed', error); return false; }
}

export async function syncToGoogleDrive(tableName: string, dataRows: unknown[]): Promise<boolean> { if (!dataRows?.length) return false; return postToScript({ action: 'saveData', table: tableName, rows: dataRows }); }

export async function backupStateToGoogle(state: unknown, kind: 'manual' | 'auto' = 'manual'): Promise<boolean> {
  if (!(await hasGoogleBackupAccess())) return false;
  return postToScript({ action: 'backupState', kind, exportedAt: new Date().toISOString(), state });
}

export async function fetchFromGoogleDrive(tableName: string): Promise<unknown[]> {
  const base = getGoogleScriptUrl(); const apiKey = requestGoogleApiKey();
  if (!base || !apiKey || !isGoogleSyncEnabled() || typeof document === 'undefined' || (typeof navigator !== 'undefined' && !navigator.onLine)) return [];
  return new Promise((resolve) => {
    const callbackName = `nexfixRows_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script'); let settled = false;
    const finish = (rows: unknown[]) => { if (settled) return; settled = true; window.clearTimeout(timer); script.remove(); try { delete (window as unknown as Record<string, unknown>)[callbackName]; } catch { /* ignore */ } resolve(rows); };
    const timer = window.setTimeout(() => finish([]), 12000);
    (window as unknown as Record<string, unknown>)[callbackName] = (payload: unknown) => { const data = payload as { ok?: boolean; rows?: unknown[] } | null; finish(data?.ok && Array.isArray(data.rows) ? data.rows : []); };
    script.onerror = () => finish([]);
    script.src = `${base}?action=getTable&table=${encodeURIComponent(tableName)}&apiKey=${encodeURIComponent(apiKey)}&callback=${encodeURIComponent(callbackName)}`;
    document.head.appendChild(script);
  });
}

/** Read the latest FullBackup row through its dedicated restricted endpoint. */
export async function fetchLatestGoogleBackup(): Promise<{ state: unknown; backedUpAt?: string; kind?: string } | null> {
  if (!(await hasGoogleBackupAccess())) return null;
  const base = getGoogleScriptUrl(); const apiKey = requestGoogleApiKey();
  if (!base || !apiKey || !isGoogleSyncEnabled() || typeof document === 'undefined' || (typeof navigator !== 'undefined' && !navigator.onLine)) return null;
  return new Promise((resolve) => {
    const callbackName = `nexfixLatestBackup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script'); let settled = false;
    const finish = (result: { state: unknown; backedUpAt?: string; kind?: string } | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      try { delete (window as unknown as Record<string, unknown>)[callbackName]; } catch { /* ignore */ }
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), 12000);
    (window as unknown as Record<string, unknown>)[callbackName] = (payload: unknown) => {
      const data = payload as { ok?: boolean; backup?: { state?: unknown; timestamp?: unknown; backupType?: unknown } | null } | null;
      if (!data?.ok || !data.backup || typeof data.backup.state !== 'string') return finish(null);
      try {
        finish({
          state: JSON.parse(data.backup.state),
          backedUpAt: typeof data.backup.timestamp === 'string' ? data.backup.timestamp : undefined,
          kind: typeof data.backup.backupType === 'string' ? data.backup.backupType : undefined,
        });
      } catch { finish(null); }
    };
    script.onerror = () => finish(null);
    script.src = `${base}?action=getLatestBackup&apiKey=${encodeURIComponent(apiKey)}&callback=${encodeURIComponent(callbackName)}`;
    document.head.appendChild(script);
  });
}
