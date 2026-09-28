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
    options: { shouldCreateUser: false },
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

  const updaterReady = await refreshDesktopUpdaterCredentials();
  return updaterReady
    ? { ok: true }
    : { ok: false, error: 'Email verified, but this machine is not yet authorized for updates' };
}
