import { flushSyncQueue, getConnectivity, getPendingSyncOperations, type Connectivity, onConnectivityChange } from './offline';

export type SyncManagerStatus =
  | 'idle'
  | 'offline'
  | 'syncing'
  | 'synced'
  | 'conflict'
  | 'error';

export interface SyncManagerState {
  status: SyncManagerStatus;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

const INITIAL: SyncManagerState = {
  status: getConnectivity() === 'offline' ? 'offline' : 'idle',
  pending: 0,
  lastSyncAt: null,
  lastError: null,
};

let state = INITIAL;
let stopConnectivity: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let retryAttempt = 0;
const listeners = new Set<(next: SyncManagerState) => void>();

function publish(next: SyncManagerState): void {
  state = next;
  listeners.forEach((listener) => listener(state));
}

async function refreshPending(): Promise<number> {
  try {
    const pending = (await getPendingSyncOperations()).length;
    if (pending !== state.pending) publish({ ...state, pending });
    return pending;
  } catch {
    return state.pending;
  }
}

export function getSyncManagerState(): SyncManagerState { return state; }

export function subscribeSyncManager(listener: (next: SyncManagerState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export async function runSyncNow(): Promise<SyncManagerState> {
  if (syncing) return state;
  if (getConnectivity() === 'offline') {
    const pending = await refreshPending();
    publish({ ...state, status: 'offline', pending });
    return state;
  }

  syncing = true;
  publish({ ...state, status: 'syncing', lastError: null });
  try {
    const result = await flushSyncQueue();
    retryAttempt = 0;
    if (result.conflict) {
      publish({ ...state, status: 'conflict', pending: result.pending });
    } else if (result.synced) {
      publish({ ...state, status: 'synced', pending: result.pending, lastSyncAt: new Date().toISOString() });
    } else {
      publish({ ...state, status: 'idle', pending: result.pending });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sync error';
    publish({ ...state, status: 'error', lastError: message });
    scheduleRetry();
  } finally {
    syncing = false;
  }
  return state;
}

function scheduleRetry(): void {
  if (retryTimer !== null || getConnectivity() === 'offline') return;
  retryAttempt = Math.min(retryAttempt + 1, 6);
  const delayMs = Math.min(60000, 2000 * 2 ** (retryAttempt - 1));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runSyncNow();
  }, delayMs);
}

export function startSyncManager(): () => void {
  if (stopConnectivity) return stopSyncManager;
  stopConnectivity = onConnectivityChange((status: Connectivity) => {
    if (status === 'online') {
      retryAttempt = 0;
      void runSyncNow();
    } else {
      publish({ ...state, status: 'offline' });
    }
  });
  void refreshPending();
  void runSyncNow();
  return stopSyncManager;
}

export function stopSyncManager(): void {
  stopConnectivity?.();
  stopConnectivity = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempt = 0;
}
