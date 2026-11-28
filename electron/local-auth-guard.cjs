const MAX_FAILURES = 5;
const BASE_LOCK_MS = 15_000;
const MAX_LOCK_MS = 300_000;
const PENDING_TTL_MS = 30_000;

/** Reject malformed persisted records before normalization can reset their attempt budget. */
function isValidLocalAuthGuardState(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 1000
    || !Number.isFinite(value.lockedUntil) || value.lockedUntil < 0) {
    return false;
  }
  if (value.pending === null) return true;
  const pending = value.pending;
  return !!pending && typeof pending === 'object' && !Array.isArray(pending)
    && typeof pending.id === 'string' && pending.id.length > 0 && pending.id.length <= 128
    && Number.isFinite(pending.startedAt) && pending.startedAt >= 0 && pending.startedAt <= now;
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    failures: Number.isInteger(source.failures) && source.failures >= 0 ? Math.min(source.failures, 1000) : 0,
    lockedUntil: Number.isFinite(source.lockedUntil) && source.lockedUntil > 0 ? source.lockedUntil : 0,
    pending: source.pending && typeof source.pending.id === 'string' && Number.isFinite(source.pending.startedAt)
      ? { id: source.pending.id, startedAt: source.pending.startedAt }
      : null,
  };
}

function lockDuration(failures) {
  if (failures < MAX_FAILURES) return 0;
  return Math.min(MAX_LOCK_MS, BASE_LOCK_MS * (2 ** Math.min(failures - MAX_FAILURES, 5)));
}

function recordFailure(state, now) {
  const failures = state.failures + 1;
  const duration = lockDuration(failures);
  return {
    ...state,
    failures,
    lockedUntil: duration ? now + duration : 0,
    pending: null,
  };
}

function beginLocalAuthAttempt(value, now, attemptId) {
  let state = normalizeState(value);
  if (state.lockedUntil > now) {
    return { state, result: { ok: false, retryAfterMs: state.lockedUntil - now } };
  }
  if (state.pending) {
    if (now - state.pending.startedAt < PENDING_TTL_MS) {
      return { state, result: { ok: false, retryAfterMs: PENDING_TTL_MS - (now - state.pending.startedAt) } };
    }
    state = recordFailure(state, now);
    if (state.lockedUntil > now) {
      return { state, result: { ok: false, retryAfterMs: state.lockedUntil - now } };
    }
  }
  const id = String(attemptId || '');
  if (!id || id.length > 128) return { state, result: { ok: false, retryAfterMs: BASE_LOCK_MS } };
  state = { ...state, pending: { id, startedAt: now } };
  return { state, result: { ok: true, attemptId: id } };
}

function completeLocalAuthAttempt(value, attemptId, success, now) {
  const state = normalizeState(value);
  if (!state.pending || state.pending.id !== attemptId || typeof success !== 'boolean') {
    return { state, result: { ok: false } };
  }
  if (success) {
    return {
      state: { version: 1, failures: 0, lockedUntil: 0, pending: null },
      result: { ok: true },
    };
  }
  return { state: recordFailure(state, now), result: { ok: true } };
}

module.exports = { beginLocalAuthAttempt, completeLocalAuthAttempt, normalizeState, isValidLocalAuthGuardState, lockDuration, PENDING_TTL_MS };
