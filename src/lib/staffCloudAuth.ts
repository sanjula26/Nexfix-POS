import type { Session } from '@supabase/supabase-js';
import { staffSupabase, staffSupabaseConfigured } from './staffSupabase';

export const STAFF_AUTH_REDIRECT_URL = 'nexfix://staff-auth/callback';

export type StaffAuthResult =
  | { ok: true; session?: Session | null }
  | { ok: false; error: string };

/**
 * Send a sign-in link to an Owner/Admin-provisioned Staff identity.
 * Self-service account creation is disabled; this does not create shop users.
 */
export async function requestStaffSignInLink(email: string): Promise<StaffAuthResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!staffSupabaseConfigured || !staffSupabase) {
    return { ok: false, error: 'Staff Cloud authentication is not configured on this POS.' };
  }
  if (!normalizedEmail || normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { ok: false, error: 'Enter a valid Staff email address.' };
  }

  const { error } = await staffSupabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: STAFF_AUTH_REDIRECT_URL,
      shouldCreateUser: false,
    },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Exchange only a Staff-audience PKCE code using the isolated Staff client. */
export async function completeStaffSignIn(code: string): Promise<StaffAuthResult> {
  const authCode = code.trim();
  if (!staffSupabaseConfigured || !staffSupabase) {
    return { ok: false, error: 'Staff Cloud authentication is not configured on this POS.' };
  }
  if (!authCode || authCode.length > 4096) {
    return { ok: false, error: 'The Staff sign-in link is invalid or expired.' };
  }

  const { data, error } = await staffSupabase.auth.exchangeCodeForSession(authCode);
  if (error) return { ok: false, error: error.message };
  if (!data.session) return { ok: false, error: 'Staff sign-in did not return a valid session.' };
  return { ok: true, session: data.session };
}

/** Clear only this device's Staff session; never sign out the Admin client. */
export async function signOutStaffSession(): Promise<StaffAuthResult> {
  if (!staffSupabaseConfigured || !staffSupabase) {
    return { ok: false, error: 'Staff Cloud authentication is not configured on this POS.' };
  }
  const { error } = await staffSupabase.auth.signOut({ scope: 'local' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Read the Staff session without touching Admin/updater auth state. */
export async function getStaffSession(): Promise<StaffAuthResult> {
  if (!staffSupabaseConfigured || !staffSupabase) {
    return { ok: false, error: 'Staff Cloud authentication is not configured on this POS.' };
  }
  const { data, error } = await staffSupabase.auth.getSession();
  if (error) return { ok: false, error: error.message };
  return { ok: true, session: data.session };
}
