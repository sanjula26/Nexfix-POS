import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const projectRef = (() => {
  try { return new URL(url).hostname.split('.')[0] || ''; } catch { return ''; }
})();

/**
 * Staff Auth is intentionally isolated from the Admin/updater singleton.
 * This client has no updater recovery, device registration, shop bootstrap,
 * cloud sync, or operational data access attached to it.
 */
export const staffSupabaseStorageKey = projectRef
  ? `nexfix-staff-${projectRef}-auth-token`
  : '';

export const staffSupabaseConfigured = Boolean(url && anonKey && projectRef);

type StaffDesktopAuthStorage = {
  isDesktop?: boolean;
  getCloudAuthStorageItem?: (key: string) => Promise<{ ok?: boolean; found?: boolean; value?: string; error?: string }>;
  setCloudAuthStorageItem?: (payload: { key: string; value: string }) => Promise<{ ok?: boolean; error?: string }>;
  removeCloudAuthStorageItem?: (key: string) => Promise<{ ok?: boolean; error?: string }>;
};

function getDesktopStorage(): StaffDesktopAuthStorage | undefined {
  try {
    return (window as Window & { nexfixDesktop?: StaffDesktopAuthStorage }).nexfixDesktop;
  } catch {
    return undefined;
  }
}

function localStorageSafe() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

const staffAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    if (!staffSupabaseStorageKey || !(
      key === staffSupabaseStorageKey ||
      key === `${staffSupabaseStorageKey}-code-verifier`
    )) return null;

    const desktop = getDesktopStorage();
    if (desktop?.isDesktop) {
      if (!desktop.getCloudAuthStorageItem) return null;
      try {
        const result = await desktop.getCloudAuthStorageItem(key);
        return result?.ok && result.found && typeof result.value === 'string'
          ? result.value
          : null;
      } catch {
        return null;
      }
    }
    return localStorageSafe()?.getItem(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!staffSupabaseStorageKey || !(
      key === staffSupabaseStorageKey ||
      key === `${staffSupabaseStorageKey}-code-verifier`
    )) throw new Error('Invalid Staff Cloud session storage key.');

    const desktop = getDesktopStorage();
    if (desktop?.isDesktop) {
      if (!desktop.setCloudAuthStorageItem) {
        throw new Error('Secure Staff Cloud session storage is unavailable in this Windows POS build.');
      }
      const result = await desktop.setCloudAuthStorageItem({ key, value });
      if (!result?.ok) throw new Error(result?.error || 'Secure Staff Cloud session storage failed.');
      try { localStorageSafe()?.removeItem(key); } catch { /* optional cleanup */ }
      return;
    }

    const local = localStorageSafe();
    if (!local) throw new Error('Staff Cloud session storage is unavailable.');
    local.setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (!staffSupabaseStorageKey || !(
      key === staffSupabaseStorageKey ||
      key === `${staffSupabaseStorageKey}-code-verifier`
    )) return;

    const desktop = getDesktopStorage();
    if (desktop?.isDesktop && desktop.removeCloudAuthStorageItem) {
      try { await desktop.removeCloudAuthStorageItem(key); } catch { /* fail closed on next read */ }
    }
    try { localStorageSafe()?.removeItem(key); } catch { /* optional cleanup */ }
  },
};

/**
 * Foundation only: no UI or sign-in entry point imports this client yet.
 * Staff PKCE callbacks must be exchanged only by a future Staff-specific flow.
 */
export const staffSupabase: SupabaseClient | null = staffSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        storage: staffAuthStorage,
        storageKey: staffSupabaseStorageKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      global: {
        headers: { 'x-client-info': 'nexfix-pos-staff-auth' },
      },
    })
  : null;
