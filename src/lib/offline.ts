/**
 * Connectivity helpers and the durable local sync queue.
 *
 * IMPORTANT: an offline operation is never deleted merely because the
 * browser comes back online. A queue item must only be acknowledged after
 * a real remote sync succeeds.
 */

import { idbEnqueue, idbListQueue } from './db';

export type Connectivity = 'online' | 'offline' | 'unknown';

export function getConnectivity(): Connectivity {
  if (typeof navigator === 'undefined') return 'unknown';
  return navigator.onLine ? 'online' : 'offline';
}

export function onConnectivityChange(cb: (status: Connectivity) => void): () => void {
  const up = () => cb('online');
  const down = () => cb('offline');
  window.addEventListener('online', up);
  window.addEventListener('offline', down);
  return () => {
    window.removeEventListener('online', up);
    window.removeEventListener('offline', down);
  };
}

/** Record a local write. The queue is intentionally durable. */
export async function queueWrite(note?: string): Promise<void> {
  await idbEnqueue({ type: 'state_write', note });
}

/**
 * Returns pending operations for a future cloud-sync worker.
 *
 * The previous implementation cleared the queue without contacting a remote
 * backend. That could make a sale appear synced while its data was lost.
 * We deliberately do NOT clear anything here. A successful cloud adapter
 * should acknowledge individual operations only after the server confirms
 * them (preferably using an idempotency key).
 */
export async function getPendingSyncOperations() {
  return idbListQueue();
}

/**
 * Compatibility wrapper. It reports pending work instead of falsely calling
 * it "flushed". This keeps existing callers safe until the Supabase sync
 * adapter is wired into the application.
 */
export async function flushSyncQueue(): Promise<{ flushed: number; pending: number; synced: boolean }> {
  const ops = await idbListQueue();
  return { flushed: 0, pending: ops.length, synced: false };
}

export async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  } catch {
    return false;
  }
}
