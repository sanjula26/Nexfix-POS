import { supabase, supabaseConfigured } from './supabase';
import { ensureCloudShop, registerDesktopUpdaterDevice, setCloudShopId } from './cloudSync';
import { getMachineIdentity } from './machine';

type CloudUpdaterRecovery = { email: string; userId: string; refreshToken: string };

function getDesktopUpdaterApi() {
  return (window as Window & {
    nexfixDesktop?: {
      setUpdateCredentials?: (payload: { token: string; deviceId: string }) => Promise<unknown>;
      clearUpdateCredentials?: () => Promise<unknown>;
      saveCloudUpdaterRecovery?: (payload: CloudUpdaterRecovery) => Promise<{ ok?: boolean; error?: string }>;
      loadCloudUpdaterRecovery?: (email: string) => Promise<{ ok?: boolean; found?: boolean; userId?: string; refreshToken?: string; error?: string }>;
    };
  }).nexfixDesktop;
}

async function saveCloudUpdaterRecovery(session: { user?: { id?: string | null; email?: string | null } | null; refresh_token?: string | null }): Promise<void> {
  const desktop = getDesktopUpdaterApi();
  if (!desktop?.saveCloudUpdaterRecovery) return;
  const email = session.user?.email?.trim().toLowerCase() || '';
  const userId = session.user?.id?.trim() || '';
  const refreshToken = session.refresh_token?.trim() || '';
  if (!email || !userId || refreshToken.length < 20) return;
  await desktop.saveCloudUpdaterRecovery({ email, userId, refreshToken });
}

async function restoreCloudUpdaterRecovery(email: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabase || !supabaseConfigured) return { ok: false, error: 'Cloud authentication is not configured' };
  const desktop = getDesktopUpdaterApi();
  if (!desktop?.loadCloudUpdaterRecovery) return { ok: false, error: 'Secure cloud recovery is available only in the installed Windows POS' };
  const wanted = email.trim().toLowerCase();
  if (!wanted) return { ok: false, error: 'Cloud account email is required' };
  const stored = await desktop.loadCloudUpdaterRecovery(wanted);
  if (!stored?.ok) return { ok: false, error: stored?.error || 'Stored cloud recovery credential is unavailable' };
  if (!stored.found || !stored.refreshToken || !stored.userId) return { ok: false, error: 'No saved cloud updater authorization exists for this admin account' };
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: stored.refreshToken });
  if (error || !data.session) return { ok: false, error: error?.message || 'Saved cloud updater authorization has expired. Re-authorize this machine.' };
  if (data.user?.id !== stored.userId || data.user.email?.trim().toLowerCase() !== wanted) {
    return { ok: false, error: 'Saved cloud updater authorization belongs to a different cloud account' };
  }
  await saveCloudUpdaterRecovery(data.session);
  const updaterReady = await refreshDesktopUpdaterCredentials();
  return updaterReady ? { ok: true } : { ok: false, error: 'Cloud session restored, but this machine is not authorized for updates' };
}

function getMachineId(): string {
  try { return getMachineIdentity().id; } catch { return ''; }
}

// Local POS login stays authoritative and must remain non-blocking. Keep the
// in-flight cloud sign-in promise in memory so Settings/App Updates can wait
// for the same credentials instead of racing the background cloud login.
let cloudLoginPromise: Promise<{ ok: boolean; error?: string }> | null = null;

async function syncDesktopUpdaterCredentials(accessToken?: string): Promise<void> {
  const desktop = getDesktopUpdaterApi();
  const deviceId = getMachineId();
  if (!desktop) return;
  if (!accessToken || !deviceId) {
    await desktop.clearUpdateCredentials?.();
    return;
  }

  // A token alone is not enough for the private updater: the device must be
  // registered to the same authenticated user and active shop first.
  if (!supabaseConfigured || !supabase) {
    await desktop.clearUpdateCredentials?.();
    return;
  }
  const shop = await ensureCloudShop('Nexfix Shop');
  if (!shop.ok || !shop.shopId) {
    await desktop.clearUpdateCredentials?.();
    return;
  }
  const { data, error } = await supabase.rpc('register_pos_device', {
    p_shop_id: shop.shopId,
    p_device_id: deviceId,
  });
  if (error || !data?.ok) {
    await desktop.clearUpdateCredentials?.();
    return;
  }

  await desktop.setUpdateCredentials?.({ token: accessToken, deviceId });
}

export async function refreshDesktopUpdaterCredentials(): Promise<boolean> {
  const desktop = getDesktopUpdaterApi();
  if (!desktop?.setUpdateCredentials) return false;
  if (!supabaseConfigured || !supabase) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  let { data, error } = await supabase.auth.getSession();
  if ((error || !data.session?.access_token) && cloudLoginPromise) {
    try { await cloudLoginPromise; } catch { /* refresh below remains authoritative */ }
    const refreshed = await supabase.auth.getSession();
    data = refreshed.data;
    error = refreshed.error;
  }
  if (error || !data.session?.access_token) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const deviceId = getMachineId();
  if (!deviceId) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const shop = await ensureCloudShop('Nexfix Shop');
  if (!shop.ok || !shop.shopId) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const registration = await registerDesktopUpdaterDevice(shop.shopId);
  if (!registration.ok) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const result = await desktop.setUpdateCredentials({
    token: data.session.access_token,
    deviceId,
  });
  return Boolean((result as { ok?: boolean } | null)?.ok);
}

/**
 * One-time first-shop provisioning for an explicitly initiated admin setup.
 * It never runs from normal login/background sync paths.
 */
export async function provisionCloudUpdaterAccount(
  email: string,
  password: string,
  shopName: string,
): Promise<{ ok: boolean; needsEmailConfirmation?: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const normalizedEmail = email.trim();
  const normalizedShopName = shopName.trim();
  if (!normalizedEmail) return { ok: false, error: 'Cloud account email is required' };
  if (password.length < 12) return { ok: false, error: 'Cloud account password must be at least 12 characters' };
  if (normalizedShopName.length < 2) return { ok: false, error: 'Shop name must be at least 2 characters' };

  // First try the supplied credentials as an existing cloud account. This
  // makes the setup retryable after email confirmation without creating a
  // second account.
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (signInError || !signInData.session) {
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: { data: { full_name: normalizedShopName } },
    });
    if (signUpError) return { ok: false, error: signUpError.message };
    if (!signUpData.session) {
      return {
        ok: false,
        needsEmailConfirmation: true,
        error: 'Cloud account created or pending confirmation. Confirm the email, then run this setup again with the same cloud credentials.',
      };
    }
  }

  const { data: provisionedSession } = await supabase.auth.getSession();
  if (provisionedSession.session) await saveCloudUpdaterRecovery(provisionedSession.session);

  const existingShop = await ensureCloudShop(normalizedShopName);
  if (existingShop.ok && existingShop.shopId) {
    const updaterReady = await refreshDesktopUpdaterCredentials();
    return updaterReady
      ? { ok: true }
      : { ok: false, error: 'Cloud membership exists, but this machine is not yet authorized for updates' };
  }

  const { data: shopId, error: bootstrapError } = await supabase.rpc('bootstrap_first_shop', {
    shop_name: normalizedShopName,
  });
  if (bootstrapError || !shopId) {
    return { ok: false, error: bootstrapError?.message || 'Cloud shop bootstrap failed' };
  }

  setCloudShopId(String(shopId));
  const updaterReady = await refreshDesktopUpdaterCredentials();
  if (!updaterReady) {
    return { ok: false, error: 'Cloud account and shop were created, but this machine is not yet authorized for updates' };
  }
  return { ok: true };
}

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      void saveCloudUpdaterRecovery(session).catch(() => {});
    }
  });
}

export async function signInToCloud(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) return { ok: false, error: error.message };
  // Do not wait for device/shop provisioning here. The caller may be the local
  // login path, which must stay fast and offline-capable. The updater refresh
  // path waits for this same in-flight login when necessary.
  return { ok: true };
}

/**
 * Local POS authentication is authoritative. Cloud authentication is a
 * background enhancement and must never delay or block entry to the POS.
 */
export async function ensureCloudSession(
  email: string,
  password: string,
  fullName: string,
  role: 'admin' | 'cashier' = 'cashier',
): Promise<{ ok: boolean; error?: string; needsEmailConfirmation?: boolean }> {
  void fullName;
  if (role !== 'admin') return { ok: true };
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const loginPromise = (async () => {
    try {
      const passwordResult = await signInToCloud(email, password);
      if (passwordResult.ok) {
        const { data } = await supabase.auth.getSession();
        if (data.session) await saveCloudUpdaterRecovery(data.session);
        return await refreshDesktopUpdaterCredentials()
          ? { ok: true }
          : { ok: true, error: 'Cloud session is signed in, but shop/device authorization is not provisioned' };
      }

      // Legacy installations may have a local Admin password that is different
      // from the provisioned cloud password. Restore the one-time migrated
      // cloud refresh capability instead of asking the user to recreate accounts.
      return await restoreCloudUpdaterRecovery(email);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Cloud session could not be established' };
    }
  })();
  cloudLoginPromise = loginPromise;
  try {
    return await loginPromise;
  } finally {
    if (cloudLoginPromise === loginPromise) cloudLoginPromise = null;
  }
}
export async function signOutFromCloud(): Promise<void> {
  try { syncDesktopUpdaterCredentials(); } catch { /* updater credentials are memory-only and will expire with the app */ }
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch { /* local session remains authoritative offline */ }
}
