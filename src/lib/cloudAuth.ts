import { supabase, supabaseConfigured } from './supabase';
import { ensureCloudShop } from './cloudSync';

export async function signInToCloud(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signUpToCloud(email: string, password: string, fullName: string) {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  const { error, data } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: fullName.trim() } },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, needsEmailConfirmation: !data.session };
}

/**
 * Local POS accounts remain the offline authority. After a successful local
 * login, establish the matching Supabase session so RLS-protected cloud sync
 * RPCs can use auth.uid(). If the cloud account does not exist yet, provision
 * it with the same credentials. A missing/disabled cloud configuration never
 * blocks local POS login.
 */
export async function ensureCloudSession(
  email: string,
  password: string,
  fullName: string,
): Promise<{ ok: boolean; error?: string; needsEmailConfirmation?: boolean }> {
  const signedIn = await signInToCloud(email, password);
  if (signedIn.ok) {
    await ensureCloudShop('Nexfix Shop');
    return signedIn;
  }
  if (signedIn.error === 'offline' || signedIn.error === 'Cloud authentication is not configured') return signedIn;

  const created = await signUpToCloud(email, password, fullName);
  if (!created.ok) return { ok: false, error: created.error };
  if (created.ok && !created.needsEmailConfirmation) {
    await ensureCloudShop('Nexfix Shop');
  }
  return created;
}

export async function signOutFromCloud(): Promise<void> {
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch { /* local session remains authoritative offline */ }
}
