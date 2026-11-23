/**
 * Tracks one class of background work and provides a pause-and-drain barrier.
 * Call pause() before taking a consistent cross-store snapshot; always release
 * the returned lease in a finally block.
 */
export interface DrainableWorkGate {
  run<T>(operation: () => Promise<T> | T, whenPaused: () => Promise<T> | T): Promise<T>;
  pause(): Promise<() => void>;
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
    async pause(): Promise<() => void> {
      if (paused || pausePending) throw new Error('Background work is already paused.');
      paused = true;
      pausePending = true;
      try { await Promise.allSettled(Array.from(active)); }
      finally { pausePending = false; }
      let released = false;
      return () => { if (released) return; released = true; paused = false; };
    },
    isPaused: () => paused,
    activeCount: () => active.size,
  };
}
