import { createDrainableWorkGate } from './drainableWorkGate';

const restoreWork = createDrainableWorkGate();

export function pauseRestoreWork(): Promise<() => void> {
  return restoreWork.pause();
}

/** Run a complete restore/checkpoint operation inside the shared restore gate. */
export function runRestoreWork<T>(
  operation: () => Promise<T> | T,
  pausedMessage = 'POS restore is temporarily paused for safe storage maintenance.',
): Promise<T> {
  return restoreWork.run(
    operation,
    () => { throw new Error(pausedMessage); },
  );
}
