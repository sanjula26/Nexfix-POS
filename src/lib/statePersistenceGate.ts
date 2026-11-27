import { createDrainableWorkGate } from './drainableWorkGate.ts';

export type StatePersistResult = {
  stateSaved: boolean;
  queueSaved: boolean;
  failureKind?: string;
};

export type StatePersistencePause<T> = StatePersistResult & {
  latestState: T;
  release: () => void;
};

/**
 * Tracks debounced state writes and makes a final latest-state attempt before
 * maintenance. Quota exhaustion is recoverable from the in-memory snapshot;
 * other storage failures abort the maintenance window.
 */
export function createStatePersistenceGate<T>(
  persist: (state: T) => Promise<StatePersistResult>,
) {
  const work = createDrainableWorkGate();

  return {
    persist(state: T): Promise<StatePersistResult> {
      return work.run(
        () => persist(state),
        () => { throw new Error('POS state persistence is temporarily paused for safe storage maintenance.'); },
      );
    },

    async pauseAndFlush(getLatestState: () => T): Promise<StatePersistencePause<T>> {
      const release = await work.pause();
      try {
        const latestState = getLatestState();
        const result = await persist(latestState);
        if ((!result.stateSaved || !result.queueSaved) && result.failureKind !== 'quota_exceeded') {
          throw new Error('Could not safely read or flush POS state, or confirm its offline queue before storage maintenance.');
        }
        return { ...result, latestState, release };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
