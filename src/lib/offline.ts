/**
 * Connectivity helpers and the durable local sync queue.
 *
 * IMPORTANT: an offline operation is never deleted merely because the
 * browser comes back online. A queue item must only be acknowledged after
 * a real remote sync succeeds.
 */

import { idbEnqueue, idbListQueue, idbLoadState } from './db';
import { syncStateSnapshot } from './cloudSync';

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

export async function queueWrite(note?: string): Promise<void> {
  await idbEnqueue({ type: 'state_write', note });
}

export async function getPendingSyncOperations() {
  return idbListQueue();
}

/**
 * On reconnect, attempt to publish the durable local snapshot. A successful
 * snapshot acknowledgement does NOT clear the operation queue because the
 * current queue still represents coarse state writes. It is safer to leave
 * those entries visible until row-level/idempotent operation acknowledgement
 * is implemented.
 */
export async function flushSyncQueue(): Promise<{ flushed: number; pending: number; synced: boolean }> {
  const ops = await idbListQueue();
  const state = await idbLoadState();
  if (!state) return { flushed: 0, pending: ops.length, synced: false };

  const result = await syncStateSnapshot(state);
  if (result.status === 'synced') {
    return { flushed: 0, pending: ops.length, synced: true };
  }
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
