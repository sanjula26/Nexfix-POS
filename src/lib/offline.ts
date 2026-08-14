/**
 * Online / offline detection + lightweight sync queue flush.
 * Without a real cloud backend, "sync" means:
 *  - queue local writes while offline
 *  - when online again, mark queue as flushed and optionally trigger a backup
 */

import { idbEnqueue, idbListQueue, idbClearQueue } from './db';

export type Connectivity = 'online' | 'offline' | 'unknown';

export function getConnectivity(): Connectivity {
  if (typeof navigator === 'undefined') return 'unknown';
  return navigator.onLine ? 'online' : 'offline';
}

/** Subscribe to online/offline changes. Returns unsubscribe. */
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

/** Record a local write into the offline queue (for future cloud sync) */
export async function queueWrite(note?: string): Promise<void> {
  await idbEnqueue({ type: 'state_write', note });
}

/**
 * Flush queue when connectivity returns.
 * Currently: clear local queue + return count of flushed ops.
 * Ready for future remote API push.
 */
export async function flushSyncQueue(): Promise<{ flushed: number }> {
  const ops = await idbListQueue();
  if (ops.length === 0) return { flushed: 0 };
  // Future: POST each op / full snapshot to cloud API here
  await idbClearQueue();
  return { flushed: ops.length };
}

/** Register a basic service worker for offline shell caching */
export async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Prefer waiting SW when available
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  } catch {
    return false;
  }
}
