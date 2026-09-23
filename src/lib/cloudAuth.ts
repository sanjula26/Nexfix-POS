import { supabase, supabaseConfigured } from './supabase';
import { ensureCloudShop } from './cloudSync';

export async function signInToCloud(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return error ? { ok: false, error: error.message } : { ok: true };
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
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };

  void (async () => {
    try {
      const signedIn = await signInToCloud(email, password);
      if (signedIn.ok) {
        await ensureCloudShop('Nexfix Shop');
        return;
      }
      if (signedIn.error === 'offline' || signedIn.error === 'Cloud authentication is not configured') return;

      // Never create a new cloud identity from a local POS login. Automatic sign-up
      // could turn an unprovisioned local cashier into the first cloud shop admin.
      // Cloud accounts and shop membership must be provisioned explicitly.
    } catch {
      // Local POS login must remain usable when Supabase is unavailable.
    }
  })();

  return { ok: true };
}

export async function signOutFromCloud(): Promise<void> {
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch { /* local session remains authoritative offline */ }
}
