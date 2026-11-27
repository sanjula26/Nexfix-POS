export interface FingerprintedSyncResult {
  ok: boolean;
}

/**
 * Shares an in-flight sync for the same identity + fingerprint and remembers
 * only successful results. A newer fingerprint waits for the current write so
 * stale catalog snapshots cannot be applied out of order.
 */
export function createFingerprintSyncCoordinator<T extends FingerprintedSyncResult>() {
  const completed = new Map<string, { fingerprint: string; result: T }>();
  const inFlight = new Map<string, { fingerprint: string; promise: Promise<T> }>();

  const run = async (identity: string, fingerprint: string, sync: () => Promise<T>): Promise<T> => {
    const cached = completed.get(identity);
    if (cached?.fingerprint === fingerprint) return cached.result;

    const active = inFlight.get(identity);
    if (active) {
      if (active.fingerprint === fingerprint) return active.promise;
      // Wait for an older catalog snapshot to finish before applying a newer
      // one. A failed older attempt must not prevent the newer state from trying.
      try { await active.promise; } catch { /* retry below with the latest fingerprint */ }
      return run(identity, fingerprint, sync);
    }

    const promise = Promise.resolve().then(sync);
    inFlight.set(identity, { fingerprint, promise });
    try {
      const result = await promise;
      if (result.ok) completed.set(identity, { fingerprint, result });
      return result;
    } finally {
      if (inFlight.get(identity)?.promise === promise) inFlight.delete(identity);
    }
  };

  const clear = (identity?: string): void => {
    if (identity) {
      completed.delete(identity);
      return;
    }
    completed.clear();
  };

  return { run, clear };
}
