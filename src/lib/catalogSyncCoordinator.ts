export interface FingerprintedSyncResult {
  ok: boolean;
}

export function createFingerprintSyncCoordinator<T extends FingerprintedSyncResult>() {
  const completed = new Map<string, { fingerprint: string; result: T }>();
  const identityTails = new Map<string, { fingerprint: string; promise: Promise<T> }>();

  const run = async (identity: string, fingerprint: string, sync: () => Promise<T>): Promise<T> => {
    const activeTail = identityTails.get(identity);
    // Deduplicate only with the newest queued operation for this identity.
    // Reusing an older matching in-flight promise across a newer queued
    // fingerprint would let the later stale snapshot overwrite the latest one.
    if (activeTail?.fingerprint === fingerprint) return activeTail.promise;
    if (!activeTail) {
      const cached = completed.get(identity);
      if (cached?.fingerprint === fingerprint) return cached.result;
    }

    const previous = activeTail?.promise.then(() => undefined, () => undefined) || Promise.resolve();
    const promise = previous.then(async () => {
      // The preceding queued sync may already have committed this exact
      // fingerprint, so reuse its success rather than issuing a duplicate.
      const latest = completed.get(identity);
      if (latest?.fingerprint === fingerprint) return latest.result;
      const result = await sync();
      if (result.ok) completed.set(identity, { fingerprint, result });
      return result;
    });
    identityTails.set(identity, { fingerprint, promise });

    try {
      return await promise;
    } finally {
      if (identityTails.get(identity)?.promise === promise) identityTails.delete(identity);
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
