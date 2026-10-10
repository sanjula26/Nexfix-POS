import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const supabaseConfigured = Boolean(url && anonKey);

type DesktopAuthStorage = {
  isDesktop?: boolean;
  getCloudAuthStorageItem?: (key: string) => Promise<{ ok?: boolean; found?: boolean; value?: string; error?: string }>;
  setCloudAuthStorageItem?: (payload: { key: string; value: string }) => Promise<{ ok?: boolean; error?: string }>;
  removeCloudAuthStorageItem?: (key: string) => Promise<{ ok?: boolean; error?: string }>;
  loadCloudUpdaterRecovery?: (email: string) => Promise<{ ok?: boolean; found?: boolean; userId?: string; refreshToken?: string; error?: string }>;
  saveCloudUpdaterRecovery?: (payload: { email: string; userId: string; refreshToken: string }) => Promise<{ ok?: boolean; error?: string }>;
  getCloudAuthSignedOut?: () => Promise<{ ok?: boolean; signedOut?: boolean; error?: string }>;
  setCloudAuthSignedOut?: (signedOut: boolean) => Promise<{ ok?: boolean; error?: string }>;
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
      const desktop = getDesktopStorage();
      let explicitlySignedOut = false;
      try {
        const secureMarker = await desktop?.getCloudAuthSignedOut?.();
        if (secureMarker?.ok) explicitlySignedOut = secureMarker.signedOut === true;
        else explicitlySignedOut = localStorage.getItem('nexfix_cloud_signed_out') === '1';
      } catch {
        try { explicitlySignedOut = localStorage.getItem('nexfix_cloud_signed_out') === '1'; } catch { /* optional */ }
      }
      if (explicitlySignedOut) {
        try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* clear unusable local state best-effort */ }
        return { ok: false, error: 'Cloud sign-in required once in Settings.' };
      }
      const { data, error } = await supabase.auth.getSession();
      if (error) return { ok: false, error: error.message };
      let session = data.session;
      if (!session) {
        // Migrate existing installations that only have the previously saved,
        // OS-encrypted refresh token. Never auto-restore after explicit sign-out.
        let signedOut = false;
        let savedEmail = '';
        try {
          signedOut = localStorage.getItem('nexfix_cloud_signed_out') === '1';
          savedEmail = localStorage.getItem('nexfix_cloud_updater_email')?.trim().toLowerCase() || '';
        } catch { /* optional migration hint */ }
        const desktop = getDesktopStorage();
        if (!signedOut && savedEmail && desktop?.loadCloudUpdaterRecovery) {
          const stored = await desktop.loadCloudUpdaterRecovery(savedEmail);
          if (stored?.ok && stored.found && stored.refreshToken && stored.userId) {
            const migrated = await supabase.auth.refreshSession({ refresh_token: stored.refreshToken });
            if (!migrated.error && migrated.data.session && migrated.data.user?.id === stored.userId &&
                migrated.data.user.email?.trim().toLowerCase() === savedEmail) {
              session = migrated.data.session;
              await desktop.saveCloudUpdaterRecovery?.({
                email: savedEmail,
                userId: session.user.id,
                refreshToken: session.refresh_token,
              });
            } else if (migrated.error && /invalid refresh token|refresh token.*(invalid|expired|not found|reuse)/i.test(migrated.error.message)) {
              return { ok: false, error: 'Saved Cloud session expired. Sign in once in Settings to restore this PC.' };
            }
          }
        }
        if (!session) return { ok: false };
      }
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

export async function setCloudSignOutMarker(signedOut: boolean): Promise<void> {
  try {
    if (signedOut) localStorage.setItem('nexfix_cloud_signed_out', '1');
    else localStorage.removeItem('nexfix_cloud_signed_out');
  } catch { /* secure Electron marker below remains authoritative */ }
  const desktop = getDesktopStorage();
  try { await desktop?.setCloudAuthSignedOut?.(signedOut); } catch { /* optional outside installed Electron */ }
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.');
  return supabase;
}
