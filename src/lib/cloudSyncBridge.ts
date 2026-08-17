import { queueWrite } from './offline';
import { runSyncNow } from './syncManager';

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a durable snapshot write after local persistence has had time to finish.
 * The queue is the retry boundary; runSyncNow only acknowledges it after the
 * Supabase snapshot RPC succeeds.
 */
export function scheduleCloudSync(note = 'state_change'): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      try {
        await queueWrite(note);
        await runSyncNow();
      } catch {
        // The durable queue preserves the write for the normal retry/reconnect path.
      }
    })();
  }, 350);
}

export function cancelScheduledCloudSync(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
