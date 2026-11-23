/**
 * App-level write gate used by the overflow migration coordinator.
 *
 * Wrap top-level POS mutation entry points with runWrite(). Do not wrap every
 * low-level IndexedDB call: nested tracked writes would be rejected after a
 * pause begins. A pause closes the gate, drains already-started operations,
 * then runs the privileged pending-state flush before handing control to the
 * migration caller. The caller must keep the lease until copy, verification,
 * and durable cutover either complete or abort.
 *
 * This module is intentionally not wired into POSProvider yet. Wiring is only
 * safe after every mutation, queue, backup, restore, and checkpoint entry point
 * has been audited and covered by integration tests.
 */

export type POSWriteQuiescenceFailure = 'paused' | 'already_paused' | 'timeout';

export class POSWriteQuiescenceError extends Error {
  readonly code: POSWriteQuiescenceFailure;

  constructor(code: POSWriteQuiescenceFailure, message: string) {
    super(message);
    this.name = 'POSWriteQuiescenceError';
    this.code = code;
  }
}

export interface POSWriteQuiescenceLease {
  /** Idempotently re-open the POS mutation gate. */
  release(): void;
}

export interface POSWriteQuiescenceCoordinator {
  readonly isPaused: boolean;
  readonly activeWrites: number;
  runWrite<T>(label: string, operation: () => T | Promise<T>): Promise<T>;
  /** Preserve sync return values while tracking sync/async top-level POS mutations. */
  runMutation<T>(label: string, operation: () => T | Promise<T>): T | Promise<T>;
  pause(options?: {
    timeoutMs?: number;
    /** Flush the latest in-memory state after tracked writes have drained. */
    flushPendingState?: () => void | Promise<void>;
  }): Promise<POSWriteQuiescenceLease>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Coordinates top-level POS writes around a bounded migration pause.
 *
 * The timeout covers both draining active writes and flushing the latest
 * in-memory state. A timeout or flush failure re-opens the gate and never
 * authorizes migration.
 */
export function createPOSWriteQuiescenceCoordinator(): POSWriteQuiescenceCoordinator {
  let paused = false;
  let activeWrites = 0;
  const idleWaiters = new Set<() => void>();

  const notifyIdle = () => {
    if (activeWrites !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const waitForIdle = (): Promise<void> => {
    if (activeWrites === 0) return Promise.resolve();
    return new Promise(resolve => idleWaiters.add(resolve));
  };

  const runWrite = async <T>(label: string, operation: () => T | Promise<T>): Promise<T> => {
    if (paused) {
      throw new POSWriteQuiescenceError(
        'paused',
        `POS writes are temporarily paused for safe local storage maintenance (${label}).`,
      );
    }

    activeWrites += 1;
    try {
      return await operation();
    } finally {
      activeWrites -= 1;
      notifyIdle();
    }
  };

  const runMutation = <T>(label: string, operation: () => T | Promise<T>): T | Promise<T> => {
    if (paused) {
      throw new POSWriteQuiescenceError(
        'paused',
        `POS writes are temporarily paused for safe local storage maintenance (${label}).`,
      );
    }

    activeWrites += 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      activeWrites -= 1;
      notifyIdle();
    };

    try {
      const result = operation();
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && typeof (result as PromiseLike<T>).then === 'function') {
        return Promise.resolve(result as PromiseLike<T>).finally(finish);
      }
      finish();
      return result as T;
    } catch (error) {
      finish();
      throw error;
    }
  };

  const pause = async (options: {
    timeoutMs?: number;
    flushPendingState?: () => void | Promise<void>;
  } = {}): Promise<POSWriteQuiescenceLease> => {
    if (paused) {
      throw new POSWriteQuiescenceError('already_paused', 'POS write maintenance is already in progress.');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('POS write pause timeout must be a positive finite number.');
    }

    // Close the gate synchronously before waiting, so no new business write
    // can enter between the idle check and snapshot preparation.
    paused = true;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new POSWriteQuiescenceError(
        'timeout',
        'POS writes did not become idle before the safe maintenance timeout.',
      )), timeoutMs);
    });

    let flushInProgress: Promise<void> | null = null;
    try {
      await Promise.race([waitForIdle(), timeout]);
      if (options.flushPendingState) {
        flushInProgress = Promise.resolve().then(options.flushPendingState);
        await Promise.race([flushInProgress, timeout]);
      }

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          paused = false;
        },
      };
    } catch (error) {
      // A failed barrier never hands a migration lease to the caller. If the
      // privileged flush itself timed out, keep the gate closed until that
      // already-started IndexedDB write settles; otherwise a late stale flush
      // could race a newly accepted POS mutation.
      if (flushInProgress) {
        void flushInProgress.then(
          () => { paused = false; },
          () => { paused = false; },
        );
      } else {
        paused = false;
      }
      throw error;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };

  return {
    get isPaused() { return paused; },
    get activeWrites() { return activeWrites; },
    runWrite,
    runMutation,
    pause,
  };
}
