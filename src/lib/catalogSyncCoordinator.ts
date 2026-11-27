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
  const inFlight = new Map<string, Map<string, Promise<T>>>();
  const identityTails = new Map<string, Promise<void>>();

  const run = async (identity: string, fingerprint: string, sync: () => Promise<T>): Promise<T> => {
    const cached = completed.get(identity);
    if (cached?.fingerprint === fingerprint) return cached.result;

    const identityFlights = inFlight.get(identity);
    const existing = identityFlights?.get(fingerprint);
    if (existing) return existing;

    // Serialize every different fingerprint in invocation order. A single
    // mutable "active fingerprint" slot can let two waiters race after an
    // older sync settles, applying catalog snapshots out of order.
    const previous = identityTails.get(identity) || Promise.resolve();
    const pending = previous.then(async () => {
      const latest = completed.get(identity);
      if (latest?.fingerprint === fingerprint) return latest.result;
      const result = await sync();
      if (result.ok) completed.set(identity, { fingerprint, result });
      return result;
    });
    const tail = pending.then(() => undefined, () => undefined);
    if (!identityFlights) inFlight.set(identity, new Map([[fingerprint, pending]]));
    else identityFlights.set(fingerprint, pending);
    identityTails.set(identity, tail);

    try {
      return await pending;
    } finally {
      const flights = inFlight.get(identity);
      if (flights?.get(fingerprint) === pending) {
        flights.delete(fingerprint);
        if (flights.size === 0) inFlight.delete(identity);
      }
      if (identityTails.get(identity) === tail) identityTails.delete(identity);
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
