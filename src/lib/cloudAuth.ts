import { supabase, supabaseConfigured } from './supabase';
import { ensureCloudShop, registerDesktopUpdaterDevice, setCloudShopId } from './cloudSync';
import { getMachineIdentity } from './machine';

function getDesktopUpdaterApi() {
  return (window as Window & {
    nexfixDesktop?: {
      setUpdateCredentials?: (payload: { token: string; deviceId: string }) => Promise<unknown>;
      clearUpdateCredentials?: () => Promise<unknown>;
    };
  }).nexfixDesktop;
}

function getMachineId(): string {
  try { return getMachineIdentity().id; } catch { return ''; }
}

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

  const { data, error } = await supabase.auth.getSession();
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

  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: { full_name: normalizedShopName },
    },
  });
  if (error) return { ok: false, error: error.message };
  if (!data.session) {
    return {
      ok: false,
      needsEmailConfirmation: true,
      error: 'Cloud account created. Confirm the email, then sign in to the cloud account and retry this setup.',
    };
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
    syncDesktopUpdaterCredentials(session?.access_token);
  });
}

export async function signInToCloud(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    syncDesktopUpdaterCredentials();
    return { ok: false, error: error.message };
  }

  const updaterReady = await refreshDesktopUpdaterCredentials();
  if (!updaterReady) {
    // Cloud sign-in can succeed before shop/device provisioning is complete.
    // Keep local POS login independent; Settings can retry authorization.
  }
  return { ok: true, error: updaterReady ? undefined : 'Cloud session is signed in, but shop/device authorization is not provisioned' };
}

/**
 * Local POS authentication is authoritative. Cloud authentication is a
 * background enhancement and must never delay or block entry to the POS.
 */
export async function ensureCloudSession(
  email: string,
  password: string,
  fullName: string,
): Promise<{ ok: boolean; error?: string; needsEmailConfirmation?: boolean }> {
  void fullName;
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  try {
    return await signInToCloud(email, password);
  } catch (error) {
    // Local POS login must remain usable when Supabase is unavailable.
    return { ok: false, error: error instanceof Error ? error.message : 'Cloud session could not be established' };
  }
}

export async function signOutFromCloud(): Promise<void> {
  try { syncDesktopUpdaterCredentials(); } catch { /* updater credentials are memory-only and will expire with the app */ }
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch { /* local session remains authoritative offline */ }
}
