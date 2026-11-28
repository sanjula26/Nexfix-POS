export type SuccessfulSyncResult = { ok: boolean };

/**
 * Reuse a successful catalog reconciliation for the same shop, user, branch
 * and normalized catalog fingerprint. Concurrent callers share one request.
 * Failed reconciliations are never cached, so the next sale can retry safely.
 */
export function createSuccessfulSingleFlightCache<T extends SuccessfulSyncResult>(maxEntries = 8) {
  const completed = new Map<string, T>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key: string, action: () => Promise<T>): Promise<T> {
      const cached = completed.get(key);
      if (cached) return Promise.resolve(cached);

      const pending = inFlight.get(key);
      if (pending) return pending;

      const task = Promise.resolve()
        .then(action)
        .then(result => {
          if (result.ok) {
            completed.delete(key);
            completed.set(key, result);
            while (completed.size > Math.max(1, maxEntries)) {
              const oldest = completed.keys().next().value;
              if (oldest === undefined) break;
              completed.delete(oldest);
            }
          }
          return result;
        })
        .finally(() => {
          if (inFlight.get(key) === task) inFlight.delete(key);
        });

      inFlight.set(key, task);
      return task;
    },
  };
}
