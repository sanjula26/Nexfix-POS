/**
 * Tracks one class of background work and provides a pause-and-drain barrier.
 * Call pause() before taking a consistent cross-store snapshot; always release
 * the returned lease in a finally block.
 */
export interface DrainableWorkGate {
  run<T>(operation: () => Promise<T> | T, whenPaused: () => Promise<T> | T): Promise<T>;
  pause(options?: { timeoutMs?: number }): Promise<() => void>;
  isPaused(): boolean;
  activeCount(): number;
}

export function createDrainableWorkGate(): DrainableWorkGate {
  let paused = false;
  let pausePending = false;
  const active = new Set<Promise<unknown>>();
  return {
    run<T>(operation: () => Promise<T> | T, whenPaused: () => Promise<T> | T): Promise<T> {
      if (paused) return Promise.resolve().then(whenPaused);
      const task = Promise.resolve().then(operation);
      active.add(task);
      const remove = () => { active.delete(task); };
      task.then(remove, remove);
      return task;
    },
    async pause(options: { timeoutMs?: number } = {}): Promise<() => void> {
      if (paused || pausePending) throw new Error('Background work is already paused.');
      const timeoutMs = options.timeoutMs ?? 15_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
        throw new RangeError('Background work drain timeout must be between 1 and 120000 milliseconds.');
      }
      paused = true;
      pausePending = true;
      const pending = Promise.allSettled(Array.from(active)).then(() => undefined);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`Background work did not drain within ${timeoutMs} ms; storage maintenance was cancelled.`));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        // Keep admission closed until the existing work really settles. The
        // caller receives no lease and must not take a storage snapshot.
        void pending.then(() => { paused = false; });
        throw error;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        pausePending = false;
      }
      let released = false;
      return () => { if (released) return; released = true; paused = false; };
    },
    isPaused: () => paused,
    activeCount: () => active.size,
  };
}
