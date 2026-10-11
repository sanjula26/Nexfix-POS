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
            if (!saved?.ok) return null;
            try { localStorageSafe()?.removeItem(key); } catch { /* optional cleanup */ }
            return oldValue;
          }
          return null;
        }
        // On Electron, never hide a secure-store failure by silently accepting
        // a browser-only session that will disappear after restart.
        return null;
      } catch { return null; }
    }
    return localStorageSafe()?.getItem(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    const desktop = getDesktopStorage();
    if (desktop?.isDesktop && desktop.setCloudAuthStorageItem) {
      try {
        const result = await desktop.setCloudAuthStorageItem({ key, value });
        if (!result?.ok) throw new Error(result?.error || 'Secure Cloud session storage failed.');
        try { localStorageSafe()?.removeItem(key); } catch { /* optional cleanup */ }
        return;
      } catch (error) {
        throw error instanceof Error ? error : new Error('Secure Cloud session storage failed.');
      }
    }
    const local = localStorageSafe();
    if (!local) throw new Error('Cloud session storage is unavailable.');
    local.setItem(key, value);
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
  } catch (error) {
    if (!signedOut) throw new Error(error instanceof Error ? error.message : 'Could not clear the local Cloud sign-out marker.');
  }
  const desktop = getDesktopStorage();
  if (desktop?.isDesktop && desktop.setCloudAuthSignedOut) {
    let result: { ok?: boolean; error?: string } | undefined;
    try { result = await desktop.setCloudAuthSignedOut(signedOut); }
    catch (error) {
      if (!signedOut) throw new Error(error instanceof Error ? error.message : 'Could not clear the secure Cloud sign-out marker.');
      return;
    }
    if (!result?.ok && !signedOut) throw new Error(result?.error || 'Could not clear the secure Cloud sign-out marker.');
    if (!signedOut) {
      const verify = await desktop.getCloudAuthSignedOut?.();
      if (!verify?.ok || verify.signedOut === true) throw new Error(verify?.error || 'Secure Cloud sign-out marker is still active.');
    }
  }
}

/** Verify that the configured Supabase auth adapter can read the durable session back. */
export async function verifyCloudSessionPersistence(refreshToken: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  const projectRef = (() => { try { return new URL(url).hostname.split('.')[0]; } catch { return ''; } })();
  if (!projectRef) return { ok: false, error: 'Could not identify the Cloud session storage key.' };
  try {
    const raw = await authStorage.getItem(`sb-${projectRef}-auth-token`);
    if (!raw) return { ok: false, error: 'Cloud session was not saved to persistent storage.' };
    const stored = JSON.parse(raw) as { refresh_token?: string };
    return stored.refresh_token === refreshToken
      ? { ok: true }
      : { ok: false, error: 'Cloud session storage read-back did not match the signed-in session.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not verify durable Cloud session storage.' };
  }
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.');
  return supabase;
}
