import { supabase, supabaseConfigured } from './supabase';
import { refreshDesktopUpdaterCredentials } from './cloudAuth';

/**
 * Legacy-install updater migration.
 * The existing local Admin/Cashier passwords remain untouched. A one-time
 * email OTP proves ownership of the provisioned cloud Admin account and then
 * the normal device-registration/update authorization path is reused.
 */
export async function requestLegacyCloudEmailOtp(email: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const normalizedEmail = email.trim();
  if (!normalizedEmail) return { ok: false, error: 'Cloud account email is required' };

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: 'nexfix://auth/callback',
    },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function verifyLegacyCloudEmailOtp(
  email: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  const normalizedEmail = email.trim();
  const normalizedToken = token.replace(/\D/g, '');
  if (!normalizedEmail) return { ok: false, error: 'Cloud account email is required' };
  if (!/^\d{6}$/.test(normalizedToken)) return { ok: false, error: 'Enter the 6-digit email verification code' };

  const { data, error } = await supabase.auth.verifyOtp({
    email: normalizedEmail,
    token: normalizedToken,
    type: 'email',
  });
  if (error || !data.session) {
    return { ok: false, error: error?.message || 'Email verification did not create a cloud session' };
  }

  // Supabase can return the session before the user fields are fully
  // hydrated in some desktop PKCE callback timings. Resolve the authenticated
  // user explicitly before persisting the recovery credential.
  const userResult = data.session.user?.id && data.session.user?.email
    ? { data: { user: data.session.user }, error: null }
    : await supabase.auth.getUser();
  const callbackUser = userResult.data?.user;
  const callbackEmail = callbackUser?.email?.trim().toLowerCase() || '';
  const callbackUserId = callbackUser?.id?.trim() || '';
  const callbackRefreshToken = data.session.refresh_token?.trim() || '';

  if (!callbackEmail || !callbackUserId || !callbackRefreshToken) {
    return { ok: false, error: 'Cloud sign-in succeeded, but Supabase did not return a complete recovery credential. Please request a new sign-in link.' };
  }

  const desktop = (window as Window & {
    nexfixDesktop?: {
      saveCloudUpdaterRecovery?: (payload: { email: string; userId: string; refreshToken: string }) => Promise<{ ok?: boolean; error?: string }>;
    };
  }).nexfixDesktop;
  if (desktop?.saveCloudUpdaterRecovery) {
    const saved = await desktop.saveCloudUpdaterRecovery({
      email: callbackEmail,
      userId: callbackUserId,
      refreshToken: callbackRefreshToken,
    });
    if (!saved?.ok) return { ok: false, error: saved?.error || 'Cloud authorization was verified but could not be stored securely' };
  } else {
    return { ok: false, error: 'Secure Windows cloud storage is unavailable. Please restart the installed POS and try again.' };
  }

  try { localStorage.setItem('nexfix_cloud_updater_email', callbackEmail); } catch { /* optional convenience only */ }

  const updaterReady = await refreshDesktopUpdaterCredentials();
  return updaterReady
    ? { ok: true }
    : { ok: false, error: 'Email verified, but this machine is not yet authorized for updates' };
}

export async function completeLegacyCloudEmailMagicLink(
  code: string,
  flowId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  const normalizedCode = code.trim();
  if (!normalizedCode) return { ok: false, error: 'The cloud sign-in link did not contain an authorization code' };

  const { data, error } = await supabase.auth.exchangeCodeForSession(
    normalizedCode,
    flowId ? { flowId } : undefined,
  );
  if (error || !data.session) {
    return { ok: false, error: error?.message || 'The cloud sign-in link could not create a session' };
  }

  const desktop = (window as Window & {
    nexfixDesktop?: {
      saveCloudUpdaterRecovery?: (payload: { email: string; userId: string; refreshToken: string }) => Promise<{ ok?: boolean; error?: string }>;
    };
  }).nexfixDesktop;
  if (desktop?.saveCloudUpdaterRecovery && data.session.user?.id && data.session.user.email && data.session.refresh_token) {
    const saved = await desktop.saveCloudUpdaterRecovery({
      email: data.session.user.email,
      userId: data.session.user.id,
      refreshToken: data.session.refresh_token,
    });
    if (!saved?.ok) return { ok: false, error: saved?.error || 'Cloud authorization was verified but could not be stored securely' };
  }

  const updaterReady = await refreshDesktopUpdaterCredentials();
  return updaterReady
    ? { ok: true }
    : { ok: false, error: 'Email sign-in succeeded, but this machine is not yet authorized for updates' };
}
