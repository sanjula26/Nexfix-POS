import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const supabaseConfigured = Boolean(url && anonKey);

type DesktopAuthStorage = {
  isDesktop?: boolean;
  getCloudAuthStorageItem?: (key: string) => Promise<{ ok?: boolean; found?: boolean; value?: string; error?: string }>;
  setCloudAuthStorageItem?: (payload: { key: string; value: string }) => Promise<{ ok?: boolean; error?: string }>;
  removeCloudAuthStorageItem?: (key: string) => Promise<{ ok?: boolean; error?: string }>;
};

function getDesktopStorage(): DesktopAuthStorage | undefined {
  try {
    return (window as Window & { nexfixDesktop?: DesktopAuthStorage }).nexfixDesktop;
  } catch {
    return undefined;
  }
}

function localStorageSafe() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * Supabase Auth stores its session and PKCE verifier through this adapter.
 * In the installed Electron app, values are encrypted by Electron safeStorage
 * (Windows DPAPI) before being written to the app's persistent userData file.
 * Browser/dev builds keep using localStorage. No cloud password is persisted.
 */
const authStorage = {
  async getItem(key: string): Promise<string | null> {
    const desktop = getDesktopStorage();
    if (desktop?.isDesktop && desktop.getCloudAuthStorageItem) {
      try {
        const result = await desktop.getCloudAuthStorageItem(key);
        if (result?.ok && result.found && typeof result.value === 'string') return result.value;
        if (result?.ok && result.found === false) {
          // One-time migration from a previous localStorage-backed session.
          const oldValue = localStorageSafe()?.getItem(key);
          if (oldValue !== null && oldValue !== undefined) {
            const saved = await desktop.setCloudAuthStorageItem?.({ key, value: oldValue });
            if (saved?.ok) {
              try { localStorageSafe()?.removeItem(key); } catch { /* optional cleanup */ }
            }
            return oldValue;
          }
          return null;
        }
      } catch { /* use browser storage as a compatibility fallback */ }
    }
    return localStorageSafe()?.getItem(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    const desktop = getDesktopStorage();
    if (desktop?.isDesktop && desktop.setCloudAuthStorageItem) {
      try {
        const result = await desktop.setCloudAuthStorageItem({ key, value });
        if (result?.ok) {
          try { localStorageSafe()?.removeItem(key); } catch { /* optional cleanup */ }
          return;
        }
      } catch { /* use browser storage as a compatibility fallback */ }
    }
    localStorageSafe()?.setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    const desktop = getDesktopStorage();
    if (desktop?.isDesktop && desktop.removeCloudAuthStorageItem) {
      try { await desktop.removeCloudAuthStorageItem(key); } catch { /* local cleanup still runs */ }
    }
    try { localStorageSafe()?.removeItem(key); } catch { /* storage may be unavailable */ }
  },
};

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        storage: authStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
      global: {
        headers: { 'x-client-info': 'nexfix-pos' },
      },
    })
  : null;

/** Wait for durable session storage to initialize and silently refresh near-expiry sessions. */
let restorePromise: Promise<{ ok: boolean; email?: string; error?: string }> | null = null;
export function restoreCloudSession(): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) return { ok: false, error: error.message };
      let session = data.session;
      if (!session) return { ok: false };
      if (session.expires_at && session.expires_at * 1000 <= Date.now() + 60_000) {
        const refreshed = await supabase.auth.refreshSession();
        if (refreshed.error || !refreshed.data.session) {
          const message = refreshed.error?.message || 'Saved cloud session could not be refreshed';
          if (/invalid refresh token|refresh token.*(invalid|expired|not found|reuse)/i.test(message)) {
            try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* clear only the unusable local session */ }
          }
          return { ok: false, error: message };
        }
        session = refreshed.data.session;
      }
      return { ok: true, email: session.user.email || undefined };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Cloud session restore failed' };
    }
  })().finally(() => { restorePromise = null; });
  return restorePromise;
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.');
  return supabase;
}
