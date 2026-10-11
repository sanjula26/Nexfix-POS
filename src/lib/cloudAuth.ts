import { restoreCloudSession, setCloudSignOutMarker, supabase, supabaseConfigured, verifyCloudSessionPersistence } from './supabase';
import { ensureCloudShop, setCloudShopId } from './cloudSync';
import { getMachineIdentity } from './machine';

type CloudUpdaterRecovery = { email: string; userId: string; refreshToken: string };

function getDesktopUpdaterApi() {
  return (window as Window & {
    nexfixDesktop?: {
      isDesktop?: boolean;
      setUpdateCredentials?: (payload: { token: string; deviceId: string; mode?: 'bearer' | 'device' }) => Promise<unknown>;
      clearUpdateCredentials?: () => Promise<unknown>;
      saveCloudUpdaterRecovery?: (payload: CloudUpdaterRecovery) => Promise<{ ok?: boolean; error?: string }>;
      loadCloudUpdaterRecovery?: (email: string) => Promise<{ ok?: boolean; found?: boolean; userId?: string; refreshToken?: string; error?: string }>;
      saveCloudUpdaterDeviceToken?: (payload: { token: string; deviceId: string }) => Promise<{ ok?: boolean; error?: string }>;
      loadCloudUpdaterDeviceToken?: () => Promise<{ ok?: boolean; found?: boolean; token?: string; deviceId?: string; error?: string }>;
      clearCloudUpdaterDeviceToken?: () => Promise<{ ok?: boolean; error?: string }>;
    };
  }).nexfixDesktop;
}

async function saveCloudUpdaterRecovery(session: { user?: { id?: string | null; email?: string | null } | null; refresh_token?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const desktop = getDesktopUpdaterApi();
  const email = session.user?.email?.trim().toLowerCase() || '';
  const userId = session.user?.id?.trim() || '';
  const refreshToken = session.refresh_token?.trim() || '';
  // Supabase refresh tokens are opaque credentials; do not enforce a minimum length.
  if (!email || !userId || !refreshToken || refreshToken.length > 16384) {
    return { ok: false, error: 'Cloud sign-in did not return a valid refresh token.' };
  }
  if (desktop?.isDesktop) {
    if (!desktop.saveCloudUpdaterRecovery || !desktop.loadCloudUpdaterRecovery) {
      return { ok: false, error: 'Secure Cloud restart recovery is unavailable in this Windows POS build.' };
    }
    try {
      const saved = await desktop.saveCloudUpdaterRecovery({ email, userId, refreshToken });
      if (!saved?.ok) return { ok: false, error: saved?.error || 'Could not save the encrypted Cloud refresh token.' };
      const readBack = await desktop.loadCloudUpdaterRecovery(email);
      if (!readBack?.ok || !readBack.found || readBack.userId !== userId || readBack.refreshToken !== refreshToken) {
        return { ok: false, error: readBack?.error || 'Encrypted Cloud refresh token could not be verified after saving.' };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not persist Cloud restart recovery.' };
    }
  }
  try { localStorage.setItem('nexfix_cloud_updater_email', email); } catch { /* optional recovery hint */ }
  return { ok: true };
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
  if (!desktop || !accessToken) return;
  // The persistent device updater credential is intentionally independent of
  // the interactive Supabase session. Signing out of cloud Auth must never
  // revoke the native updater credential; it remains valid until the device is
  // explicitly revoked server-side.

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

const UPDATER_AUTH_TIMEOUT_MS = 12000;

async function issueDesktopUpdaterDeviceToken(shopId: string, currentToken = ''): Promise<string> {
  const desktop = getDesktopUpdaterApi();
  if (!desktop?.saveCloudUpdaterDeviceToken || !supabase) return '';
  const rpcPromise = supabase.rpc('authorize_pos_updater_device', {
    p_shop_id: shopId,
    p_device_id: getMachineId(),
    p_current_token: currentToken,
  });
  const { data, error } = await Promise.race([
    rpcPromise,
    new Promise<{ data: null; error: { message: string } }>((resolve) =>
      window.setTimeout(() => resolve({ data: null, error: { message: 'Windows update authorization timed out. Please check the internet connection and try again.' } }), UPDATER_AUTH_TIMEOUT_MS),
    ),
  ]);
  const token = typeof data?.token === 'string' ? data.token.trim() : '';
  if (error || data?.ok !== true || token.length < 64) return '';
  const saved = await desktop.saveCloudUpdaterDeviceToken({ token, deviceId: getMachineId() });
  return saved?.ok ? token : '';
}

async function refreshDesktopUpdaterCredentialsInternal(): Promise<boolean> {
  const desktop = getDesktopUpdaterApi();
  if (!desktop?.setUpdateCredentials) return false;
  const currentDeviceId = getMachineId();
  if (!currentDeviceId) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  // Preferred path: the one-time Windows authorization creates a high-entropy
  // per-device updater token. It is encrypted with Windows safeStorage and is
  // independent of the Supabase interactive session, so local POS logout,
  // cashier/admin switching, refresh-token rotation, and future app updates do
  // not require the cloud email/password again.
  const storedDeviceToken = await desktop.loadCloudUpdaterDeviceToken?.();
  const storedDeviceTokenValue = storedDeviceToken?.ok && storedDeviceToken.found && storedDeviceToken.token
    ? storedDeviceToken.token.trim()
    : '';
  if (storedDeviceTokenValue) {
    const storedDeviceId = storedDeviceToken?.deviceId?.trim() || '';
    // A token is bound to one Windows device identity. Never silently reuse a
    // token with a different local machine identity (for example after a
    // restored profile or machine-id reset); fall through to the authenticated
    // provisioning path so the server can issue a token for this device.
    if (storedDeviceId && storedDeviceId === currentDeviceId) {
      const result = await desktop.setUpdateCredentials({
        token: storedDeviceTokenValue,
        deviceId: currentDeviceId,
        mode: 'device',
      });
      if ((result as { ok?: boolean } | null)?.ok) return true;
    } else {
      await desktop.clearUpdateCredentials?.();
    }
  }

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

  // Backward-compatible migration: older installations stored a Supabase
  // refresh token instead of a device token. Use it once to issue the new
  // per-device token, then all later updates are independent of Auth sessions.
  if (error || !data.session?.access_token) {
    let cloudEmail = '';
    try { cloudEmail = localStorage.getItem('nexfix_cloud_updater_email')?.trim().toLowerCase() || ''; } catch { /* optional storage */ }
    if (cloudEmail) {
      const stored = await desktop.loadCloudUpdaterRecovery?.(cloudEmail);
      if (stored?.ok && stored.found && stored.refreshToken && stored.userId) {
        const restored = await supabase.auth.refreshSession({ refresh_token: stored.refreshToken });
        if (!restored.error && restored.data.session && restored.data.user?.id === stored.userId && restored.data.user.email?.trim().toLowerCase() === cloudEmail) {
          await saveCloudUpdaterRecovery(restored.data.session);
          data = restored.data;
          error = restored.error;
        }
      }
    }
  }

  if (error || !data.session?.access_token) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const shop = await ensureCloudShop('Nexfix Shop');
  if (!shop.ok || !shop.shopId) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const token = await issueDesktopUpdaterDeviceToken(shop.shopId, storedDeviceTokenValue);
  if (!token) {
    await desktop.clearUpdateCredentials?.();
    return false;
  }

  const result = await desktop.setUpdateCredentials({
    token,
    deviceId: currentDeviceId,
    mode: 'device',
  });
  return Boolean((result as { ok?: boolean } | null)?.ok);
}

let updaterRefreshPromise: Promise<boolean> | null = null;

export async function refreshDesktopUpdaterCredentials(): Promise<boolean> {
  if (updaterRefreshPromise) return updaterRefreshPromise;
  const promise = (async () => {
    const internal = refreshDesktopUpdaterCredentialsInternal();
    const result = await Promise.race([
      internal,
      new Promise<boolean>((resolve) =>
        window.setTimeout(() => resolve(false), UPDATER_AUTH_TIMEOUT_MS),
      ),
    ]);
    return result;
  })();
  updaterRefreshPromise = promise;
  try {
    return await promise;
  } finally {
    if (updaterRefreshPromise === promise) updaterRefreshPromise = null;
  }
}

/**
 * Authorize this Windows PC for an already-provisioned shop.
 * First-shop creation is intentionally not part of this client flow: only a
 * trusted project owner should bootstrap an empty Supabase project.
 */
export async function provisionCloudUpdaterAccount(
  email: string,
  password: string,
  _shopName: string,
): Promise<{ ok: boolean; needsEmailConfirmation?: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return { ok: false, error: 'Cloud account email is required' };

  // Reuse the current authenticated session when it is already the intended
  // cloud account; do not ask the owner to type the password again.
  const current = await supabase.auth.getSession();
  if (current.error) return { ok: false, error: current.error.message };
  const currentEmail = current.data.session?.user.email?.trim().toLowerCase() || '';
  if (current.data.session && currentEmail && currentEmail !== normalizedEmail) {
    return { ok: false, error: `This POS is signed in as ${currentEmail}. Use that email, or sign out and sign in with the intended shop account.` };
  }
  if (!current.data.session) {
    if (!password) return { ok: false, error: 'Sign in to the existing Cloud account first.' };
    const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
    if (error || !data.session) {
      return { ok: false, error: error?.message || 'Cloud sign-in failed. Check the existing Cloud account credentials.' };
    }
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) {
    return { ok: false, error: sessionError?.message || 'Cloud sign-in required once in Settings.' };
  }
  await saveCloudUpdaterRecovery(sessionData.session);

  const existingShop = await ensureCloudShop();
  if (!existingShop.ok || !existingShop.shopId) {
    const detail = existingShop.error || '';
    if (/membership is not provisioned|no active.*membership|shop membership/i.test(detail)) {
      return {
        ok: false,
        error: 'This cloud user has no shop membership. Ask the owner to add this user in shop_memberships, or use the existing cloud admin account that already owns the shop.',
      };
    }
    // Never leak a revoked bootstrap RPC permission error to the operator.
    if (/bootstrap_first_shop|permission denied for function/i.test(detail)) {
      return {
        ok: false,
        error: 'This cloud user has no shop membership. Ask the owner to add this user in shop_memberships, or use the existing cloud admin account that already owns the shop.',
      };
    }
    return { ok: false, error: detail || 'Could not resolve the existing Cloud shop membership.' };
  }

  setCloudShopId(existingShop.shopId);
  const updaterReady = await refreshDesktopUpdaterCredentials();
  return updaterReady
    ? { ok: true }
    : { ok: false, error: 'Cloud shop membership is confirmed, but this Windows PC is not yet authorized for updates. Retry authorization while online.' };
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
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) return { ok: false, error: 'Enter the Cloud account email and password.' };

  // Drain any startup restore already in flight before clearing markers;
  // otherwise a stale restore can sign out the newly authenticated session.
  await restoreCloudSession();
  // Clear BOTH browser and Electron secure sign-out markers before Auth emits
  // SIGNED_IN; otherwise startup/session listeners can immediately sign us out.
  try { await setCloudSignOutMarker(false); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not clear the Cloud sign-out marker.' }; }

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });
  if (signInError) return { ok: false, error: signInError.message };
  if (!signInData.session) return { ok: false, error: 'Cloud sign-in returned no session. Please try again.' };

  // Supabase Auth may emit SIGNED_IN before async storage writes have finished.
  // Verify the public session and the configured durable storage before success.
  const { data: verifiedData, error: verifyError } = await supabase.auth.getSession();
  if (verifyError || !verifiedData.session) {
    return { ok: false, error: verifyError?.message || 'Cloud sign-in succeeded but the session could not be read back.' };
  }
  if (verifiedData.session.user.id !== signInData.session.user.id ||
      verifiedData.session.refresh_token !== signInData.session.refresh_token) {
    return { ok: false, error: 'Cloud session read-back did not match the signed-in account.' };
  }
  const persistence = await verifyCloudSessionPersistence(verifiedData.session.refresh_token);
  if (!persistence.ok) return { ok: false, error: persistence.error || 'Cloud session was not persisted.' };

  const recovery = await saveCloudUpdaterRecovery(verifiedData.session);
  if (!recovery.ok) return { ok: false, error: recovery.error || 'Cloud restart recovery could not be saved.' };

  const membership = await ensureCloudShop();
  if (!membership.ok || !membership.shopId) {
    const detail = membership.error || '';
    if (/membership is not provisioned|no active.*membership|shop membership/i.test(detail)) {
      return { ok: false, error: 'Cloud sign-in succeeded, but this user has no active shop membership. Ask the shop owner to add this user to shop_memberships.' };
    }
    return { ok: false, error: detail || 'Could not resolve the Cloud shop membership.' };
  }
  setCloudShopId(membership.shopId);
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
  // Honor the durable Electron sign-out marker before attempting any
  // legacy local-password auto-login or updater recovery path.
  const durableRestore = await restoreCloudSession();
  if (durableRestore.ok) {
    void refreshDesktopUpdaterCredentials().catch(() => {});
    return { ok: true };
  }
  if (durableRestore.error === 'Cloud sign-in required once in Settings.') return { ok: true };
  // A deliberate Cloud sign-out must not be undone by the local POS login flow.
  try { if (localStorage.getItem('nexfix_cloud_signed_out') === '1') return { ok: true }; } catch { /* storage is optional */ }
  // A persisted cloud session takes precedence over the separate local POS credentials.
  const restoredSession = await supabase.auth.getSession();
  if (!restoredSession.error && restoredSession.data.session) {
    // Preserve the existing updater provisioning/refresh path without making
    // cloud session persistence depend on updater authorization success.
    void refreshDesktopUpdaterCredentials().catch(() => {});
    return { ok: true };
  }


  const loginPromise = (async () => {
    try {
      let provisionedCloudEmail = '';
      try { provisionedCloudEmail = localStorage.getItem('nexfix_cloud_updater_email')?.trim().toLowerCase() || ''; } catch { /* optional storage */ }

      // If the provisioned cloud Admin email differs from the local POS login,
      // restore the encrypted cloud credential instead of trying the local
      // password against a different cloud account.
      if (provisionedCloudEmail && provisionedCloudEmail !== email.trim().toLowerCase()) {
        const restored = await restoreCloudUpdaterRecovery(provisionedCloudEmail);
        return restored.ok ? restored : { ok: true, error: restored.error || 'Cloud updater authorization is not provisioned' };
      }

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
  // Sign out only this PC's Supabase session. Other PCs and the independent
  // native updater device credential must remain authorized.
  await setCloudSignOutMarker(true);
  if (!supabase) return;
  try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* local session cleanup is best-effort when storage is unavailable */ }
}
