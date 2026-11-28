export interface LocalAuthAttemptResult {
  allowed: boolean;
  success: boolean;
  retryAfterMs: number;
}

interface GuardState {
  version: 1;
  failures: number;
  lockedUntil: number;
  pending: { id: string; startedAt: number } | null;
}

interface GuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'nexfix_local_auth_guard_v1';
export type LocalAuthAttemptScope = 'admin' | 'cashier-unlock';
const storageKeyForScope = (scope: LocalAuthAttemptScope): string => scope === 'admin'
  ? STORAGE_KEY
  : `${STORAGE_KEY}_${scope}`;
const MAX_FAILURES = 5;
const BASE_LOCK_MS = 15_000;
const MAX_LOCK_MS = 300_000;
const PENDING_TTL_MS = 30_000;

const emptyState = (): GuardState => ({ version: 1, failures: 0, lockedUntil: 0, pending: null });

const lockDuration = (failures: number): number => failures < MAX_FAILURES
  ? 0
  : Math.min(MAX_LOCK_MS, BASE_LOCK_MS * (2 ** Math.min(failures - MAX_FAILURES, 5)));

const recordFailure = (state: GuardState, now: number): GuardState => {
  const failures = state.failures + 1;
  const duration = lockDuration(failures);
  return { ...state, failures, lockedUntil: duration ? now + duration : 0, pending: null };
};

/** Browser/dev fallback. Packaged Electron uses the main-process guard instead. */
export const createLocalAuthGuard = (
  storage: GuardStorage,
  now: () => number = () => Date.now(),
  makeId: () => string = () => globalThis.crypto.randomUUID(),
  storageKey: string = STORAGE_KEY,
) => {
  const read = (): GuardState => {
    const raw = storage.getItem(storageKey);
    if (!raw) return emptyState();
    try {
      const value = JSON.parse(raw) as Partial<GuardState>;
      if (value.version !== 1 || !Number.isInteger(value.failures) || (value.failures || 0) < 0 ||
        !Number.isFinite(value.lockedUntil) ||
        (value.pending !== null && value.pending !== undefined &&
          (typeof value.pending.id !== 'string' || !Number.isFinite(value.pending.startedAt)))) {
        throw new Error('Invalid local auth guard state');
      }
      return {
        version: 1,
        failures: Math.min(value.failures || 0, 1000),
        lockedUntil: value.lockedUntil || 0,
        pending: value.pending ? { id: value.pending.id, startedAt: value.pending.startedAt } : null,
      };
    } catch {
      const locked = { version: 1 as const, failures: MAX_FAILURES, lockedUntil: now() + MAX_LOCK_MS, pending: null };
      try { storage.setItem(storageKey, JSON.stringify(locked)); } catch { /* remain fail-closed if storage is unavailable */ }
      return locked;
    }
  };
  const write = (state: GuardState) => storage.setItem(storageKey, JSON.stringify(state));

  return {
    begin() {
      let state = read();
      const time = now();
      if (state.lockedUntil > time) return { ok: false as const, retryAfterMs: state.lockedUntil - time };
      if (state.pending) {
        if (time - state.pending.startedAt < PENDING_TTL_MS) {
          return { ok: false as const, retryAfterMs: PENDING_TTL_MS - (time - state.pending.startedAt) };
        }
        state = recordFailure(state, time);
        if (state.lockedUntil > time) {
          write(state);
          return { ok: false as const, retryAfterMs: state.lockedUntil - time };
        }
      }
      const attemptId = makeId();
      if (!attemptId || attemptId.length > 128) return { ok: false as const, retryAfterMs: BASE_LOCK_MS };
      write({ ...state, pending: { id: attemptId, startedAt: time } });
      return { ok: true as const, attemptId };
    },
    complete(attemptId: string, success: boolean) {
      const state = read();
      if (!state.pending || state.pending.id !== attemptId) return false;
      write(success ? emptyState() : recordFailure(state, now()));
      return true;
    },
  };
};

type DesktopAuthBridge = {
  beginLocalAuthAttempt?: (scope: LocalAuthAttemptScope) => Promise<{ ok: boolean; attemptId?: string; retryAfterMs?: number; error?: string }>;
  completeLocalAuthAttempt?: (payload: { scope: LocalAuthAttemptScope; attemptId: string; success: boolean }) => Promise<{ ok: boolean }>;
};

const browserGuards = new Map<LocalAuthAttemptScope, ReturnType<typeof createLocalAuthGuard>>();

const getBrowserGuard = (scope: LocalAuthAttemptScope) => {
  let guard = browserGuards.get(scope);
  if (!guard) {
    if (typeof window === 'undefined' || !window.localStorage) throw new Error('Local authentication guard is unavailable');
    guard = createLocalAuthGuard(window.localStorage, undefined, undefined, storageKeyForScope(scope));
    browserGuards.set(scope, guard);
  }
  return guard;
};

/**
 * Runs a local credential check behind a persisted attempt gate. The credential
 * itself is never sent to Electron IPC or written to storage.
 */
export const runLocalAuthAttempt = async (
  verify: () => Promise<boolean> | boolean,
  scope: LocalAuthAttemptScope = 'admin',
): Promise<LocalAuthAttemptResult> => {
  let attemptId = '';
  let finish: (success: boolean) => Promise<boolean>;
  try {
    const bridge = (window as Window & { nexfixDesktop?: DesktopAuthBridge }).nexfixDesktop;
    if (bridge?.beginLocalAuthAttempt && bridge.completeLocalAuthAttempt) {
      const begun = await bridge.beginLocalAuthAttempt(scope);
      if (!begun?.ok || !begun.attemptId) {
        return { allowed: false, success: false, retryAfterMs: Math.max(1000, begun?.retryAfterMs || 30_000) };
      }
      attemptId = begun.attemptId;
      finish = async success => (await bridge.completeLocalAuthAttempt!({ scope, attemptId, success }))?.ok === true;
    } else {
      const guard = getBrowserGuard(scope);
      const begun = guard.begin();
      if (!begun.ok) return { allowed: false, success: false, retryAfterMs: begun.retryAfterMs };
      attemptId = begun.attemptId;
      finish = async success => guard.complete(attemptId, success);
    }
  } catch {
    return { allowed: false, success: false, retryAfterMs: 30_000 };
  }

  let verified = false;
  try { verified = await verify(); } catch { verified = false; }
  let persisted = false;
  try { persisted = await finish(verified); } catch { persisted = false; }
  return { allowed: persisted, success: persisted && verified, retryAfterMs: persisted ? 0 : 30_000 };
};
