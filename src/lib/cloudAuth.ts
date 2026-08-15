import { supabase, supabaseConfigured } from './supabase';

export async function signInToCloud(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signUpToCloud(email: string, password: string, fullName: string) {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  const { error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: fullName.trim() } },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signOutFromCloud(): Promise<void> {
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch { /* local session remains authoritative offline */ }
}
