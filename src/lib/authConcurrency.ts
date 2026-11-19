export type AsyncLock = { current: boolean };

/**
 * Run one asynchronous operation at a time for a shared lock.
 * The lock is always released, including when the operation rejects.
 */
export async function runWithAsyncLock<T>(
  lock: AsyncLock,
  busyResult: () => T,
  operation: () => Promise<T>,
): Promise<T> {
  if (lock.current) return busyResult();
  lock.current = true;
  try {
    return await operation();
  } finally {
    lock.current = false;
  }
}
