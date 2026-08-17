import { queueWrite } from './offline';
import { runSyncNow } from './syncManager';
import { getCloudShopId } from './cloudSync';
import { supabase, supabaseConfigured } from './supabase';

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a durable snapshot write after local persistence has had time to finish.
 * Queueing is gated by the real Supabase session so an unconfigured/local-only
 * installation never accumulates cloud queue records that can never be flushed.
 */
export function scheduleCloudSync(note = 'state_change'): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      try {
        if (!supabaseConfigured || !supabase || !getCloudShopId()) return;
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session) return;
        await queueWrite(note);
        await runSyncNow();
      } catch {
        // The normal connectivity/retry path will retry after a durable queue write.
      }
    })();
  }, 350);
}

export function cancelScheduledCloudSync(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
