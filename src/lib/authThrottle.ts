export type AuthThrottleStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AuthThrottleState {
  failures: number;
  lockedUntil: number;
}

const STORAGE_PREFIX = 'nexfix_auth_throttle_v1:';
const FAILURE_LIMIT = 5;
const BASE_LOCK_SECONDS = 15;
const MAX_LOCK_SECONDS = 300;
const memoryState = new Map<string, AuthThrottleState>();

const resolveStorage = (storage?: AuthThrottleStorage | null): AuthThrottleStorage | null => {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

const validState = (value: unknown): AuthThrottleState | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AuthThrottleState>;
  if (!Number.isSafeInteger(candidate.failures) || (candidate.failures ?? -1) < 0) return null;
  if (!Number.isSafeInteger(candidate.lockedUntil) || (candidate.lockedUntil ?? -1) < 0) return null;
  return { failures: candidate.failures!, lockedUntil: candidate.lockedUntil! };
};

const readState = (scope: string, storage: AuthThrottleStorage | null): AuthThrottleState => {
  const memory = memoryState.get(scope) ?? { failures: 0, lockedUntil: 0 };
  if (!storage) return memory;
  try {
    const raw = storage.getItem(STORAGE_PREFIX + scope);
    if (!raw) return memory;
    const parsed = validState(JSON.parse(raw));
    if (!parsed) return memory;
    return {
      failures: Math.max(memory.failures, parsed.failures),
      lockedUntil: Math.max(memory.lockedUntil, parsed.lockedUntil),
    };
  } catch {
    return memory;
  }
};

const writeState = (scope: string, state: AuthThrottleState, storage: AuthThrottleStorage | null): void => {
  memoryState.set(scope, state);
  if (!storage) return;
  try {
    storage.setItem(STORAGE_PREFIX + scope, JSON.stringify(state));
  } catch {
    // Keep the in-memory guard active if browser storage is unavailable or full.
  }
};

/** Remaining local backoff for a credential scope, in milliseconds. */
export const getAuthThrottleWaitMs = (
  scope: string,
  now = Date.now(),
  storage?: AuthThrottleStorage | null,
): number => {
  const state = readState(scope, resolveStorage(storage));
  return Math.max(0, state.lockedUntil - now);
};

/** Record a failed credential check and apply bounded exponential backoff. */
export const recordAuthThrottleFailure = (
  scope: string,
  now = Date.now(),
  storage?: AuthThrottleStorage | null,
): AuthThrottleState => {
  const target = resolveStorage(storage);
  const previous = readState(scope, target);
  const failures = previous.failures + 1;
  const lockSeconds = failures >= FAILURE_LIMIT
    ? Math.min(MAX_LOCK_SECONDS, BASE_LOCK_SECONDS * (2 ** Math.min(failures - FAILURE_LIMIT, 5)))
    : 0;
  const next = { failures, lockedUntil: lockSeconds ? now + lockSeconds * 1000 : 0 };
  writeState(scope, next, target);
  return next;
};

/** Clear the shared failure counter after a successful credential check. */
export const clearAuthThrottle = (scope: string, storage?: AuthThrottleStorage | null): void => {
  memoryState.delete(scope);
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.removeItem(STORAGE_PREFIX + scope);
  } catch {
    // Clearing the persistent copy is best-effort; memory state is already cleared.
  }
};
